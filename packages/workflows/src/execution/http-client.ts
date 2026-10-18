import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import zlib from "node:zlib";
import { TotalBaseError } from "@totalbase/errors";

/**
 * The HTTP request step's outbound client (Specification_Workflows.md §5.15):
 * refuses a destination that resolves to a non-public address (SSRF) unless
 * `workflows.http_allowed_hosts` lists it.
 *
 * The check runs inside the socket's own DNS lookup, so the address that was
 * validated is the address connected to - no second resolution a rebinding
 * DNS server could answer differently. An IP literal skips DNS and is checked
 * before connecting. Redirects are followed by hand, each hop checked again.
 */

/** Never reachable from a step unless allowed: loopback, private, link-local (cloud metadata included), CGNAT, unspecified, multicast, reserved/broadcast, IPv4-mapped/compatible and NAT64 forms. */
// Two lists: an IPv6 rule covering ::ffff:0:0/96 also matches every IPv4 address checked against the same BlockList.
const BLOCKED_V4 = new BlockList();
const BLOCKED_V6 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) BLOCKED_V4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) BLOCKED_V6.addSubnet(network, prefix, "ipv6");

export interface OutboundPolicy {
  /** Lower-cased hostnames exempted whatever they resolve to. */
  hostnames: Set<string>;
  /** IP addresses and CIDR ranges exempted. */
  addresses: BlockList;
}

/** Builds the policy from `workflows.http_allowed_hosts` (entries validated when the setting is saved). */
export function outboundPolicy(allowedHosts: string[]): OutboundPolicy {
  const hostnames = new Set<string>();
  const addresses = new BlockList();
  for (const raw of allowedHosts) {
    const entry = raw.trim();
    const [address, prefix] = entry.split("/");
    const family = isIP(address ?? "");
    if (family === 0) hostnames.add(entry.toLowerCase());
    else if (prefix === undefined) addresses.addAddress(address!, family === 4 ? "ipv4" : "ipv6");
    else addresses.addSubnet(address!, Number(prefix), family === 4 ? "ipv4" : "ipv6");
  }
  return { hostnames, addresses };
}

/** Whether `address` (an IP) may be connected to under `policy`. */
export function isAddressAllowed(address: string, policy: OutboundPolicy): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  const type = family === 4 ? "ipv4" : "ipv6";
  const blocked = family === 4 ? BLOCKED_V4.check(address, "ipv4") : BLOCKED_V6.check(address, "ipv6");
  return !blocked || policy.addresses.check(address, type);
}

function blocked(host: string, address: string): TotalBaseError {
  return new TotalBaseError(
    "WORKFLOW_HTTP_DESTINATION_BLOCKED",
    `HTTP request to ${host} refused: it resolves to ${address}, a private, loopback or reserved address. An administrator can allow it in Settings > Workflows (workflows.http_allowed_hosts).`,
  );
}

/** A `lookup` for the socket: resolves every address and refuses the connection if any of them is not allowed. */
function guardedLookup(policy: OutboundPolicy): LookupFunction {
  return ((hostname: string, options: { all?: boolean; family?: number }, callback: (...args: unknown[]) => void) => {
    dnsLookup(hostname, { family: options.family ?? 0, all: true }, (error, addresses: LookupAddress[]) => {
      if (error) return callback(error);
      const refused = addresses.find((entry) => !isAddressAllowed(entry.address, policy));
      if (refused || addresses.length === 0) return callback(blocked(hostname, refused?.address ?? "no address"));
      if (options.all) return callback(null, addresses);
      return callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  }) as unknown as LookupFunction;
}

export interface OutboundRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | undefined;
  timeoutMs: number;
  maxRedirects?: number;
  /** The run's cancellation (Specification_Workflows.md §8.5) - aborts the exchange at once. */
  signal?: AbortSignal | undefined;
  /** The most bytes read from a response (compressed or not); past it the transfer is cut. */
  maxResponseBytes?: number;
}

export interface OutboundResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  url: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);

function decode(body: Buffer, encoding: string | undefined): Buffer {
  switch (encoding?.trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return zlib.gunzipSync(body);
    case "deflate":
      return zlib.inflateSync(body);
    case "br":
      return zlib.brotliDecompressSync(body);
    default:
      return body;
  }
}

/** A response past `maxResponseBytes`: the transfer is cut and the step fails. */
function tooLarge(limit: number): TotalBaseError {
  return new TotalBaseError("WORKFLOW_LIMIT_EXCEEDED", `HTTP response larger than ${limit} bytes (workflows.http_max_response_bytes) - the transfer was cut.`);
}

function send(target: URL, request: OutboundRequest, policy: OutboundPolicy, signal: AbortSignal): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const host = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const exempt = policy.hostnames.has(host);
  if (!exempt && isIP(host) !== 0 && !isAddressAllowed(host, policy)) return Promise.reject(blocked(host, host));
  const transport = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const outgoing = transport.request(target, {
      method: request.method,
      headers: request.headers,
      signal,
      // An exempted hostname resolves normally; every other one through the check.
      ...(exempt ? {} : { lookup: guardedLookup(policy) }),
    }, (response) => {
      const chunks: Buffer[] = [];
      const limit = request.maxResponseBytes ?? Number.POSITIVE_INFINITY;
      let received = 0;
      response.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > limit) {
          response.destroy();
          outgoing.destroy();
          reject(tooLarge(limit));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        try {
          const body = decode(Buffer.concat(chunks), response.headers["content-encoding"]);
          if (body.length > limit) return reject(tooLarge(limit));
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body });
        } catch (error) {
          reject(error);
        }
      });
    });
    outgoing.on("error", reject);
    outgoing.end(request.body);
  });
}

/**
 * One outbound exchange: http/https only, each hop's destination checked
 * against `policy`, at most `maxRedirects` (5) redirects. A 303 - and a 301/302
 * after a POST - continues as a GET without a body, as browsers do; credentials
 * headers are dropped when a redirect leaves the original origin.
 */
export async function outboundFetch(request: OutboundRequest, policy: OutboundPolicy): Promise<OutboundResponse> {
  const signal = request.signal ? AbortSignal.any([AbortSignal.timeout(request.timeoutMs), request.signal]) : AbortSignal.timeout(request.timeoutMs);
  let url = new URL(request.url);
  let { method, body } = request;
  let headers = { ...request.headers };
  const origin = url.origin;
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", `HTTP request supports http and https URLs only, not ${url.protocol}`);
    }
    const response = await send(url, { ...request, method, headers, body }, policy, signal);
    const location = response.headers.location;
    if (!REDIRECT_STATUSES.has(response.status) || !location) {
      const flat: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) flat[name] = Array.isArray(value) ? value.join(", ") : value;
      return { status: response.status, headers: flat, body: response.body, url: url.toString() };
    }
    if (hop >= (request.maxRedirects ?? 5)) throw new TotalBaseError("INTERNAL_ERROR", `HTTP request failed: more than ${request.maxRedirects ?? 5} redirects.`);
    url = new URL(location, url);
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
      headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !["content-type", "content-length"].includes(name.toLowerCase())));
    }
    if (url.origin !== origin) headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase())));
  }
}
