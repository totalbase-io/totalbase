import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { HEADER_HEADROOM_BYTES, maxHeaderSizeFor } from "./hardening.js";
import { setupTestApp } from "./test-support.js";

/**
 * Query strings beyond Node's default header limit
 * (Data_API.md §12.1): the real server, over a real socket -
 * `inject()` bypasses Node's HTTP parser, which is what rejects an
 * oversized request line with a raw 431 before any hook runs. The server
 * sets maxHeaderSize from api.max_query_string_bytes at startup, so a query
 * string past the setting gets QUERY_STRING_TOO_LARGE in the error envelope.
 */
describe("query strings beyond Node's default header limit", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let base: string;
  let startupLimit: number;

  const get = (queryBytes: number) => fetch(`${base}/health/live?x=${"a".repeat(queryBytes - 2)}`);

  beforeAll(async () => {
    ({ app, context } = await setupTestApp());
    startupLimit = await context.settings.get("api.max_query_string_bytes");
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await context.settings.reset("api.max_query_string_bytes");
    await app.close();
  });

  it("sizes Node's header limit from the setting plus headroom", () => {
    expect(maxHeaderSizeFor(32_768)).toBe(32_768 + HEADER_HEADROOM_BYTES);
    expect(maxHeaderSizeFor(256)).toBeGreaterThan(16_384);
  });

  it("serves a 20 KB query string under the setting, past Node's 16 KB default", async () => {
    expect(startupLimit).toBeGreaterThan(20_480);
    const res = await get(20_480);
    expect(res.status).toBe(200);
  });

  it("answers a query string past the setting with QUERY_STRING_TOO_LARGE in the error envelope", async () => {
    const res = await get(startupLimit + 1_000);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe("QUERY_STRING_TOO_LARGE");
  });

  it("applies a lower limit live: a 20 KB query string becomes QUERY_STRING_TOO_LARGE", async () => {
    await context.settings.set("api.max_query_string_bytes", 10_240);
    try {
      const res = await get(20_480);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe("QUERY_STRING_TOO_LARGE");
    } finally {
      await context.settings.reset("api.max_query_string_bytes");
    }
  });

  it("past the startup ceiling (a limit raised live without a restart) Node's own 431 remains", async () => {
    const res = await get(maxHeaderSizeFor(startupLimit) + 1_000);
    expect(res.status).toBe(431);
  });
});
