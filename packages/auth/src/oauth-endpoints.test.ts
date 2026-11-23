import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { providerJson } from "./oauth-endpoints.js";

/**
 * Security regression (Security.md §2.11): an identity provider's discovery document, token endpoint and profile were
 * fetched with no timeout and read whole - a slow or endless answer held a sign-in, and the process's memory.
 */
describe("providerJson", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === "/huge") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(`{"x":"${"a".repeat(2 * 1024 * 1024)}"}`);
        return;
      }
      if (request.url === "/missing") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ issuer: "local" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("reads a provider's JSON, and says a non-2xx is one", async () => {
    expect(await providerJson(`${base}/ok`)).toEqual({ status: 200, json: { issuer: "local" } });
    expect(await providerJson(`${base}/missing`)).toEqual({ status: 404, json: null });
  });

  it("stops reading an answer past its size limit", async () => {
    await expect(providerJson(`${base}/huge`)).rejects.toMatchObject({ code: "OAUTH_UPSTREAM_ERROR" });
  });
});
