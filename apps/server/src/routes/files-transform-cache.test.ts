import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { setupTestApp } from "../test-support.js";

// A 2x2 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==",
  "base64",
);

/** A transformed image's Cache-Control follows files.transforms.cache_ttl_seconds (Specification_Administration.md §10.8). */
describe("image transformation Cache-Control", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let fileId: string;

  beforeAll(async () => {
    ({ app, context } = await setupTestApp());
    fileId = (await context.filesAdmin.upload({
      content: PNG,
      filename: "files-transform-cache-test.png",
      declaredContentType: "image/png",
      visibility: "PUBLIC",
    })).id;
  });

  afterAll(async () => {
    await context.settings.reset("files.transforms.cache_ttl_seconds");
    await context.filesAdmin.remove(fileId).catch(() => undefined);
    await app.close();
  });

  it("answers the configured lifetime, and a changed one on the next request", async () => {
    const get = () => app.inject({ method: "GET", url: `/api/totalbase/table/files/${fileId}?width=1` });
    const first = await get();
    expect(first.statusCode).toBe(200);
    expect(first.headers["cache-control"]).toBe("private, max-age=2592000");
    await context.settings.set("files.transforms.cache_ttl_seconds", 600);
    expect((await get()).headers["cache-control"]).toBe("private, max-age=600");
  });
});
