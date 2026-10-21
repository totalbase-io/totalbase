import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FilesS3StorageProvider, signS3Request } from "./s3-storage-provider.js";

// AWS's own examples for Signature Version 4 on S3 ("Authenticating Requests: Using the Authorization Header").
const AWS_EXAMPLE = {
  region: "us-east-1",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  date: new Date("2013-05-24T00:00:00Z"),
};
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("signS3Request", () => {
  it("signs AWS's GET Object example", () => {
    const headers = signS3Request({
      ...AWS_EXAMPLE,
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { range: "bytes=0-9" },
      payloadHash: EMPTY,
    });
    expect(headers["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("signs AWS's GET Bucket (list objects) example, its query sorted", () => {
    const headers = signS3Request({
      ...AWS_EXAMPLE,
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J"),
      payloadHash: EMPTY,
    });
    expect(headers["authorization"]).toContain("Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
  });
});

interface Recorded { method: string; url: string; headers: Record<string, string> }

function fakeFetch(respond: (request: Recorded) => Response): { fetch: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = { method: init?.method ?? "GET", url: String(input), headers: init?.headers as Record<string, string> };
    requests.push(request);
    return respond(request);
  }) as typeof fetch;
  return { fetch: impl, requests };
}

const CONFIG = {
  endpoint: "https://s3.example.com",
  region: "us-east-1",
  bucket: "files",
  prefix: "prod/",
  pathStyle: false,
  accessKeyId: "AKID",
  secretAccessKey: "secret",
};

describe("FilesS3StorageProvider", () => {
  it("addresses an object virtual-hosted or path-style, under the prefix", async () => {
    const virtual = fakeFetch(() => new Response(null, { status: 200 }));
    await new FilesS3StorageProvider(CONFIG, virtual.fetch).store("ab/cd/x y", Buffer.from("x"));
    expect(virtual.requests[0]).toMatchObject({ method: "PUT", url: "https://files.s3.example.com/prod/ab/cd/x%20y" });

    const path = fakeFetch(() => new Response(null, { status: 200 }));
    await new FilesS3StorageProvider({ ...CONFIG, endpoint: "http://minio:9000", pathStyle: true }, path.fetch).store("k", Buffer.from("x"));
    expect(path.requests[0]!.url).toBe("http://minio:9000/files/prod/k");
    expect(path.requests[0]!.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\//);
  });

  it("refuses a key that climbs out of the prefix", async () => {
    const provider = new FilesS3StorageProvider(CONFIG, fakeFetch(() => new Response(null)).fetch);
    await expect(provider.read("../other/key")).rejects.toMatchObject({ code: "FILE_STORAGE_ERROR" });
    await expect(provider.read("/abs")).rejects.toMatchObject({ code: "FILE_STORAGE_ERROR" });
  });

  it("reports the service's own reason, and a missing object as not existing", async () => {
    const { fetch } = fakeFetch((request) => request.method === "HEAD"
      ? new Response(null, { status: 404 })
      : new Response("<Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist</Message></Error>", { status: 404 }));
    const provider = new FilesS3StorageProvider(CONFIG, fetch);
    expect(await provider.exists("k")).toBe(false);
    await expect(provider.read("k")).rejects.toMatchObject({
      code: "FILE_STORAGE_ERROR",
      message: "Failed to read file content: 404 The specified bucket does not exist",
    });
  });

  it("lists every page, keys without the prefix, and deletes them in one request", async () => {
    const pages = [
      `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t&amp;2</NextContinuationToken><Contents><Key>prod/derivatives/a/1</Key><LastModified>2026-10-01T00:00:00.000Z</LastModified></Contents></ListBucketResult>`,
      `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>prod/derivatives/b/2&amp;3</Key><LastModified>2026-10-02T00:00:00.000Z</LastModified></Contents></ListBucketResult>`,
    ];
    const { fetch, requests } = fakeFetch((request) => request.method === "POST"
      ? new Response("<DeleteResult></DeleteResult>")
      : new Response(pages.shift()!));
    const provider = new FilesS3StorageProvider(CONFIG, fetch);
    await provider.deletePrefix("derivatives");
    expect(requests.map((r) => r.method)).toEqual(["GET", "GET", "POST"]);
    expect(new URL(requests[0]!.url).searchParams.get("prefix")).toBe("prod/derivatives/");
    expect(new URL(requests[1]!.url).searchParams.get("continuation-token")).toBe("t&2");
    expect(requests[2]!.headers["content-md5"]).toBeTruthy();
  });
});

describe("FilesS3StorageProvider.storeFile", () => {
  async function file(bytes: number): Promise<string> {
    const path = join(await mkdtemp(join(tmpdir(), "s3-test-")), "backup.tar");
    await writeFile(path, Buffer.alloc(bytes, 7));
    return path;
  }

  it("stores a small file in one PUT", async () => {
    const { fetch, requests } = fakeFetch(() => new Response(null));
    await new FilesS3StorageProvider(CONFIG, fetch, 10).storeFile("backups/a.tar", await file(10));
    expect(requests.map((r) => r.method)).toEqual(["PUT"]);
  });

  it("stores a larger one as a multipart upload, its parts in order, then completes it with their ETags", async () => {
    const { fetch, requests } = fakeFetch((request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.searchParams.has("uploads")) return new Response("<InitiateMultipartUploadResult><UploadId>u-1</UploadId></InitiateMultipartUploadResult>");
      if (request.method === "PUT") return new Response(null, { headers: { etag: `"e${url.searchParams.get("partNumber")}"` } });
      return new Response("<CompleteMultipartUploadResult></CompleteMultipartUploadResult>");
    });
    await new FilesS3StorageProvider(CONFIG, fetch, 10).storeFile("backups/a.tar", await file(25));
    expect(requests.map((r) => `${r.method} ${new URL(r.url).searchParams.get("partNumber") ?? ""}`.trim())).toEqual(["POST", "PUT 1", "PUT 2", "PUT 3", "POST"]);
    expect(new URL(requests[4]!.url).searchParams.get("uploadId")).toBe("u-1");
  });

  it("aborts the upload when a part fails - no half object left behind", async () => {
    const { fetch, requests } = fakeFetch((request) => {
      if (request.method === "POST") return new Response("<InitiateMultipartUploadResult><UploadId>u-2</UploadId></InitiateMultipartUploadResult>");
      if (request.method === "PUT") return new Response("<Error><Message>Slow down</Message></Error>", { status: 503 });
      return new Response(null, { status: 204 });
    });
    await expect(new FilesS3StorageProvider(CONFIG, fetch, 10).storeFile("backups/a.tar", await file(25))).rejects.toThrow(/Slow down/);
    expect(requests.at(-1)!.method).toBe("DELETE");
  });
});

/**
 * Against a real S3-compatible service, when one is given - e.g. MinIO:
 *   docker run --rm -d -p 9000:9000 minio/minio server /data
 *   TOTALBASE_TEST_S3_ENDPOINT=http://localhost:9000 TOTALBASE_TEST_S3_BUCKET=totalbase-test
 *   TOTALBASE_TEST_S3_ACCESS_KEY_ID=minioadmin TOTALBASE_TEST_S3_SECRET_ACCESS_KEY=minioadmin
 * The bucket must exist.
 */
const LIVE = process.env["TOTALBASE_TEST_S3_ENDPOINT"];
describe.skipIf(!LIVE)("FilesS3StorageProvider against a real service", () => {
  const live = () => new FilesS3StorageProvider({
    endpoint: LIVE ?? "",
    region: process.env["TOTALBASE_TEST_S3_REGION"] ?? "us-east-1",
    bucket: process.env["TOTALBASE_TEST_S3_BUCKET"] ?? "",
    prefix: `test-${randomUUID()}/`,
    pathStyle: process.env["TOTALBASE_TEST_S3_PATH_STYLE"] !== "false",
    accessKeyId: process.env["TOTALBASE_TEST_S3_ACCESS_KEY_ID"] ?? "",
    secretAccessKey: process.env["TOTALBASE_TEST_S3_SECRET_ACCESS_KEY"] ?? "",
  });

  it("stores, reads, lists and deletes", async () => {
    const provider = live();
    const content = Buffer.from([0, 1, 2, 255]);
    await provider.store("ab/cd/file one", content);
    await provider.store("derivatives/f/1", Buffer.from("a"));
    await provider.store("derivatives/f/2", Buffer.from("b"));
    expect(await provider.read("ab/cd/file one")).toEqual(content);
    expect(await provider.exists("ab/cd/file one")).toBe(true);
    expect((await provider.list("derivatives")).map((o) => o.key).sort()).toEqual(["derivatives/f/1", "derivatives/f/2"]);
    await provider.deletePrefix("derivatives");
    expect(await provider.list("derivatives")).toEqual([]);
    await provider.delete("ab/cd/file one");
    expect(await provider.exists("ab/cd/file one")).toBe(false);
    await provider.delete("ab/cd/file one");
  });
});
