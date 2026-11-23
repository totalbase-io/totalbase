import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { trustProxyOption } from "./client-ip.js";

/**
 * Security regression (Administration.md §7.7): `security.trust_proxy` on without a list of proxies believed every
 * hop of X-Forwarded-For - its left end is whatever the client sent, so any client chose its own address.
 */
describe("trustProxyOption", () => {
  const ipBehind = async (option: ReturnType<typeof trustProxyOption>, forwardedFor: string) => {
    const app = Fastify({ trustProxy: option });
    app.get("/", async (request) => ({ ip: request.ip }));
    const response = await app.inject({ method: "GET", url: "/", remoteAddress: "10.0.0.2", headers: { "x-forwarded-for": forwardedFor } });
    await app.close();
    return response.json().ip as string;
  };

  it("with trust_proxy on, takes the address the proxy in front appended - never one the client wrote", async () => {
    expect(await ipBehind(trustProxyOption([], true), "6.6.6.6, 203.0.113.7")).toBe("203.0.113.7");
  });

  it("off, the connection's own address; with a list, only the listed proxies' header", async () => {
    expect(await ipBehind(trustProxyOption([], false), "6.6.6.6")).toBe("10.0.0.2");
    expect(await ipBehind(trustProxyOption(["10.0.0.2"], false), "6.6.6.6, 203.0.113.7")).toBe("203.0.113.7");
  });
});
