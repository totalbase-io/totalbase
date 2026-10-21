import { createHash, createHmac } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { TotalBaseError } from "@totalbase/errors";
import type { FilesStorageProvider, StoredObject } from "./storage-provider.js";

export interface S3StorageConfig {
  /** The service's base URL: https://s3.us-east-1.amazonaws.com, https://<account>.r2.cloudflarestorage.com, http://minio:9000. */
  endpoint: string;
  region: string;
  bucket: string;
  /** Prepended to every key - several instances can share a bucket. "" or a path ending in "/". */
  prefix: string;
  /** endpoint/bucket/key (MinIO, most self-hosted services) instead of bucket.endpoint/key. */
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

const REQUEST_TIMEOUT_MS = 30_000;
/** A multipart upload's part: S3 takes 5 MiB to 5 GiB, at most 10,000 parts - 64 MiB holds a 640 GB file. */
const PART_SIZE = 64 * 1024 * 1024;
const DELETE_BATCH = 1000;
const EMPTY_SHA256 = createHash("sha256").digest("hex");

/** RFC 3986 percent-encoding, as SigV4 wants it (encodeURIComponent leaves !'()* alone). */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

export interface SignS3Input {
  method: string;
  url: URL;
  /** Headers to sign besides host, x-amz-date and x-amz-content-sha256 (lowercase names). */
  headers?: Record<string, string>;
  payloadHash: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  date: Date;
}

/**
 * AWS Signature Version 4 for S3 (the `s3` service): the headers to send,
 * Authorization included. The URL's path is already encoded once, as S3
 * expects - never twice.
 */
export function signS3Request(input: SignS3Input): Record<string, string> {
  const amzDate = input.date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...input.headers,
    host: input.url.host,
    "x-amz-content-sha256": input.payloadHash,
    "x-amz-date": amzDate,
  };
  const names = Object.keys(headers).map((name) => name.toLowerCase()).sort();
  const canonicalHeaders = names.map((name) => `${name}:${String(headers[name]).trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const query = [...input.url.searchParams.entries()]
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const canonicalRequest = [input.method, input.url.pathname || "/", query, canonicalHeaders, signedHeaders, input.payloadHash].join("\n");
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

function encodeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function tag(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return match ? decodeXml(match[1]!) : undefined;
}

/**
 * Content in an S3-compatible bucket (Administration.md §7.9, §10.2): Amazon S3,
 * Cloudflare R2, MinIO, Backblaze B2, Wasabi... One provider for all of them -
 * the S3 API, signed with SigV4 over `fetch`, no SDK.
 */
export class FilesS3StorageProvider implements FilesStorageProvider {
  readonly name = "s3";
  private readonly base: URL;
  private readonly prefix: string;

  constructor(
    private readonly config: S3StorageConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    /** A multipart upload's part size - S3's minimum is 5 MiB; smaller only in tests. */
    private readonly partSize: number = PART_SIZE,
  ) {
    this.base = new URL(config.endpoint);
    this.prefix = config.prefix;
  }

  /** Same rule as the local provider's base path: a key never climbs out of the prefix. */
  private objectKey(key: string): string {
    const segments = key.split("/");
    if (!key || key.startsWith("/") || segments.some((segment) => segment === "." || segment === "..")) {
      throw new TotalBaseError("FILE_STORAGE_ERROR", "Refusing to access a storage key outside the configured prefix.");
    }
    return this.prefix + key;
  }

  /** The bucket's URL, plus an object key (each segment encoded once) when given. */
  private url(objectKey?: string): URL {
    const basePath = this.base.pathname.replace(/\/+$/, "");
    const keyPath = objectKey === undefined ? "/" : `/${objectKey.split("/").map(encodeRfc3986).join("/")}`;
    const url = new URL(this.base.origin);
    if (this.config.pathStyle) {
      url.pathname = `${basePath}/${encodeRfc3986(this.config.bucket)}${keyPath}`;
    } else {
      url.host = `${this.config.bucket}.${this.base.host}`;
      url.pathname = `${basePath}${keyPath}`;
    }
    return url;
  }

  private async send(
    action: string,
    method: string,
    url: URL,
    options: { body?: Buffer; headers?: Record<string, string>; accept?: number[]; stream?: boolean } = {},
  ): Promise<Response> {
    const payloadHash = options.body ? createHash("sha256").update(options.body).digest("hex") : EMPTY_SHA256;
    const headers = signS3Request({
      method,
      url,
      ...(options.headers && { headers: options.headers }),
      payloadHash,
      region: this.config.region,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      date: new Date(),
    });
    delete headers["host"];
    let response: Response;
    // A streamed body (a backup's download) may take longer than any timeout: only its headers are waited for.
    // A large part's upload gets a second more per MiB.
    const controller = new AbortController();
    const timeoutMs = REQUEST_TIMEOUT_MS + (options.body ? Math.ceil(options.body.length / 1_048_576) * 1000 : 0);
    const timer = setTimeout(() => controller.abort(new Error("The request timed out.")), timeoutMs);
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        ...(options.body && { body: options.body }),
        signal: options.stream ? controller.signal : AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new TotalBaseError("FILE_STORAGE_ERROR", `Failed to ${action}: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    if (response.ok || options.accept?.includes(response.status)) return response;
    const text = await response.text().catch(() => "");
    const reason = tag(text, "Message") ?? tag(text, "Code") ?? response.statusText;
    throw new TotalBaseError("FILE_STORAGE_ERROR", `Failed to ${action}: ${response.status} ${reason}`.trim());
  }

  async store(key: string, content: Buffer): Promise<void> {
    await this.send("store file content", "PUT", this.url(this.objectKey(key)), {
      body: content,
      headers: { "content-type": "application/octet-stream" },
    });
  }

  async read(key: string): Promise<Buffer> {
    const response = await this.send("read file content", "GET", this.url(this.objectKey(key)));
    return Buffer.from(await response.arrayBuffer());
  }

  /** The object's content as a stream - a backup's download, never held in memory. */
  async readStream(key: string): Promise<Readable> {
    const response = await this.send("read stored content", "GET", this.url(this.objectKey(key)), { stream: true });
    if (!response.body) throw new TotalBaseError("FILE_STORAGE_ERROR", "Failed to read stored content: empty response.");
    return Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
  }

  /**
   * A local file stored under `key` without holding it in memory: one PUT up to a part's size, a multipart upload
   * (64 MiB parts, read from disk one at a time) above it - aborted on failure, so no half object is left billed.
   */
  async storeFile(key: string, path: string): Promise<void> {
    const { size } = await stat(path);
    const handle = await open(path, "r");
    try {
      const part = async (index: number) => {
        const length = Math.min(this.partSize, size - index * this.partSize);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, index * this.partSize);
        return buffer;
      };
      const objectUrl = this.url(this.objectKey(key));
      if (size <= this.partSize) {
        await this.send("store content", "PUT", objectUrl, { body: await part(0), headers: { "content-type": "application/octet-stream" } });
        return;
      }
      const start = new URL(objectUrl);
      start.searchParams.set("uploads", "");
      const uploadId = tag(await (await this.send("start an upload", "POST", start, { headers: { "content-type": "application/octet-stream" } })).text(), "UploadId");
      if (!uploadId) throw new TotalBaseError("FILE_STORAGE_ERROR", "Failed to start an upload: no upload id.");
      try {
        const etags: string[] = [];
        for (let index = 0; index * this.partSize < size; index++) {
          const url = new URL(objectUrl);
          url.searchParams.set("partNumber", String(index + 1));
          url.searchParams.set("uploadId", uploadId);
          const response = await this.send("upload a part", "PUT", url, { body: await part(index) });
          etags.push(response.headers.get("etag") ?? "");
        }
        const done = new URL(objectUrl);
        done.searchParams.set("uploadId", uploadId);
        const body = Buffer.from(`<CompleteMultipartUpload>${etags.map((etag, index) => `<Part><PartNumber>${index + 1}</PartNumber><ETag>${encodeXml(etag)}</ETag></Part>`).join("")}</CompleteMultipartUpload>`);
        const xml = await (await this.send("complete an upload", "POST", done, { body, headers: { "content-type": "application/xml" } })).text();
        // S3 may answer 200 with an error in the body.
        if (/<Error>/.test(xml)) throw new TotalBaseError("FILE_STORAGE_ERROR", `Failed to complete an upload: ${tag(xml, "Message") ?? tag(xml, "Code") ?? "unknown error"}`);
      } catch (error) {
        const abort = new URL(objectUrl);
        abort.searchParams.set("uploadId", uploadId);
        await this.send("abort an upload", "DELETE", abort, { accept: [404] }).catch(() => undefined);
        throw error;
      }
    } finally {
      await handle.close();
    }
  }

  async exists(key: string): Promise<boolean> {
    const response = await this.send("check file content", "HEAD", this.url(this.objectKey(key)), { accept: [404] });
    return response.status !== 404;
  }

  async delete(key: string): Promise<void> {
    await this.send("delete file content", "DELETE", this.url(this.objectKey(key)), { accept: [404] });
  }

  /** ListObjectsV2, every page; keys come back without the configured prefix, like the local provider's. */
  async list(prefix: string): Promise<StoredObject[]> {
    const listed = `${this.objectKey(prefix).replace(/\/+$/, "")}/`;
    const objects: StoredObject[] = [];
    let token: string | undefined;
    do {
      const url = this.url();
      url.searchParams.set("list-type", "2");
      url.searchParams.set("prefix", listed);
      if (token) url.searchParams.set("continuation-token", token);
      const xml = await (await this.send("list stored content", "GET", url)).text();
      for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = tag(match[1]!, "Key");
        if (key === undefined || !key.startsWith(this.prefix)) continue;
        const modified = tag(match[1]!, "LastModified");
        objects.push({ key: key.slice(this.prefix.length), modifiedAt: modified ? new Date(modified) : new Date(0) });
      }
      token = tag(xml, "IsTruncated") === "true" ? tag(xml, "NextContinuationToken") : undefined;
    } while (token);
    return objects;
  }

  /** DeleteObjects, a thousand keys at a time. */
  async deletePrefix(prefix: string): Promise<void> {
    const keys = (await this.list(prefix)).map((object) => this.prefix + object.key);
    for (let start = 0; start < keys.length; start += DELETE_BATCH) {
      const batch = keys.slice(start, start + DELETE_BATCH);
      const body = Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>${batch.map((key) => `<Object><Key>${encodeXml(key)}</Key></Object>`).join("")}</Delete>`,
      );
      const url = this.url();
      url.searchParams.set("delete", "");
      const response = await this.send("delete stored content", "POST", url, {
        body,
        headers: { "content-md5": createHash("md5").update(body).digest("base64"), "content-type": "application/xml" },
      });
      const xml = await response.text();
      const failed = /<Error>([\s\S]*?)<\/Error>/.exec(xml);
      if (failed) {
        throw new TotalBaseError("FILE_STORAGE_ERROR", `Failed to delete stored content: ${tag(failed[1]!, "Message") ?? tag(failed[1]!, "Code") ?? "unknown error"}`);
      }
    }
  }
}
