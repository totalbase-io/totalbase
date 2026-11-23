import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CERTIFICATE_WARNING_DAYS, certificateStatus, checkPublicUrl, PublicUrlMonitor, type PublicUrlCheck } from "./public-url-check.js";

const DAY = 24 * 60 * 60 * 1000;
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(self)",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

describe("certificateStatus", () => {
  const now = Date.parse("2026-11-20T12:00:00Z");
  const at = (days: number) => new Date(now + days * DAY);

  it("calls a certificate a browser refuses, or one past its end, invalid", () => {
    expect(certificateStatus({ valid: false, error: "SELF_SIGNED_CERT_IN_CHAIN", validTo: at(300) }, now)).toBe("invalid");
    expect(certificateStatus({ valid: true, error: null, validTo: at(-1) }, now)).toBe("invalid");
  });

  it(`warns from ${CERTIFICATE_WARNING_DAYS} days before it ends`, () => {
    expect(certificateStatus({ valid: true, error: null, validTo: at(CERTIFICATE_WARNING_DAYS) }, now)).toBe("expiring");
    expect(certificateStatus({ valid: true, error: null, validTo: at(CERTIFICATE_WARNING_DAYS + 1) }, now)).toBe("ok");
  });

  it("has nothing to say about an http URL", () => {
    expect(certificateStatus(null, now)).toBeNull();
  });
});

describe("checkPublicUrl", () => {
  let complete: FastifyInstance;
  let stripped: FastifyInstance;
  const urlOf = (app: FastifyInstance) => {
    const address = app.server.address();
    return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  };

  beforeAll(async () => {
    // What the instance answers, and what a proxy that drops two headers and the page's CSP answers.
    complete = Fastify();
    complete.get("/health/live", async (_request, reply) => reply.headers(SECURITY_HEADERS).send({ status: "live" }));
    complete.get("/", async (_request, reply) => reply.headers({ ...SECURITY_HEADERS, "content-security-policy": "default-src 'self'" }).type("text/html").send("<html></html>"));
    stripped = Fastify();
    const { "permissions-policy": _p, "cross-origin-opener-policy": _c, ...kept } = SECURITY_HEADERS;
    stripped.get("/health/live", async (_request, reply) => reply.headers(kept).send({ status: "live" }));
    stripped.get("/", async (_request, reply) => reply.headers(kept).type("text/html").send("<html></html>"));
    await complete.listen({ host: "127.0.0.1", port: 0 });
    await stripped.listen({ host: "127.0.0.1", port: 0 });
  });

  afterAll(async () => {
    await complete.close();
    await stripped.close();
  });

  it("finds every security header through the public URL when nothing removes them", async () => {
    const result = await checkPublicUrl(urlOf(complete));
    expect(result).toMatchObject({ reachable: true, certificate: null, missingHeaders: [] });
  });

  it("names the headers a proxy removed, the page's Content-Security-Policy included", async () => {
    const result = await checkPublicUrl(`${urlOf(stripped)}/`);
    expect(result.missingHeaders).toEqual(["permissions-policy", "cross-origin-opener-policy", "content-security-policy"]);
  });

  it("says when the public URL can't be reached, and nothing more", async () => {
    const closed = Fastify();
    await closed.listen({ host: "127.0.0.1", port: 0 });
    const url = urlOf(closed);
    await closed.close();
    expect(await checkPublicUrl(url)).toMatchObject({ reachable: false, certificate: null, missingHeaders: [] });
  });
});

describe("PublicUrlMonitor", () => {
  const result = (url: string, checkedAt = new Date()): PublicUrlCheck => ({ url, reachable: true, certificate: null, missingHeaders: [], checkedAt });

  it("answers the last check without waiting, and checks again in the background once it is an hour old or the URL changed", async () => {
    const checked: string[] = [];
    let at = new Date();
    const monitor = new PublicUrlMonitor(async (url) => {
      checked.push(url);
      return result(url, at);
    });
    expect(monitor.current("https://a.example")).toBeNull();
    await monitor.settled();
    expect(monitor.current("https://a.example")?.url).toBe("https://a.example");
    expect(checked).toEqual(["https://a.example"]);

    // An hour later: the old answer still, a new check under way.
    expect(monitor.current("https://a.example", Date.now() + 60 * 60 * 1000)?.url).toBe("https://a.example");
    await monitor.settled();
    expect(checked).toHaveLength(2);

    // Another public URL: the old URL's answer isn't this one's.
    at = new Date();
    expect(monitor.current("https://b.example")).toBeNull();
    await monitor.settled();
    expect(monitor.current("https://b.example")?.url).toBe("https://b.example");
  });
});
