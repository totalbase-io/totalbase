import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { setupTestApp } from "../test-support.js";

// A 2x2 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==",
  "base64",
);

// Another image: a 1x1 PNG.
const PNG_EDITED = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * A file's content - original or rendition - is revalidated against its checksum (Administration.md §10.8): the URL
 * doesn't change when the content is replaced, so a cached copy must never outlive it.
 */
describe("file content revalidation", () => {
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
    await context.filesAdmin.remove(fileId).catch(() => undefined);
    await app.close();
  });

  it.each([["a rendition", "?width=1"], ["the original", ""]])("answers %s with its checksum, 304 while unchanged, and the new content once replaced", async (_label, query) => {
    const get = (ifNoneMatch?: string) => app.inject({
      method: "GET",
      url: `/api/totalbase/table/files/${fileId}${query}`,
      headers: ifNoneMatch ? { "if-none-match": ifNoneMatch } : {},
    });
    const first = await get();
    expect(first.statusCode).toBe(200);
    expect(first.headers["cache-control"]).toBe("private, no-cache");
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);

    expect((await get(etag)).statusCode).toBe(304);
    expect((await get(`W/${etag}`)).statusCode).toBe(304);

    await context.filesAdmin.updateContent(fileId, PNG_EDITED);
    try {
      const replaced = await get(etag);
      expect(replaced.statusCode).toBe(200);
      expect(replaced.headers.etag).not.toBe(etag);
    } finally {
      await context.filesAdmin.updateContent(fileId, PNG);
    }
  });
});
