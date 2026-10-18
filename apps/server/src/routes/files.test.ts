import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { createTestApiToken, setupTestApp } from "../test-support.js";

/**
 * Route-level acceptance tests for the public Files API (routes/files.ts)
 * - proves the row-filter-aware permission model and the public-content
 * bypass (`visibility = PUBLIC`) actually work end to end, not just
 * typecheck. `totalbase.files` gets a real
 * totalbase.resources row (schema "totalbase") the same way
 * totalbase.templates does (schema "public") - grants go through
 * the exact same totalbase.permissions + EffectivePermissionService
 * engine, via context.permissions (admin-permissions.ts's own service),
 * same shape as templates.test.ts's own /pdf acceptance tests.
 */
describe("Files public API (/api/totalbase/table/files)", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let roleId: string;
  let apiKeyPlain: string;
  let apiKeyUserId: string;
  let otherRoleId: string;
  let otherApiKeyPlain: string;
  let otherApiKeyUserId: string;
  let publicFileId: string;
  let privateFileId: string;
  let filesResourceId: string;

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());

    const resourceRow = await database.query<{ id: string }>(
      `SELECT id FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = 'files'`,
    );
    filesResourceId = resourceRow.rows[0]!.id;

    const role = await context.roles.create("files-pkg-test-role", { apiAccess: true });
    roleId = role.id;
    const created = await createTestApiToken(context, {
      name: "files-pkg-test-key",
      roleId,
      email: "files-pkg-test-key@example.com",
    });
    apiKeyPlain = created.plainKey;
    apiKeyUserId = created.userId;

    const otherRole = await context.roles.create("files-pkg-test-role-other", { apiAccess: true });
    otherRoleId = otherRole.id;
    const otherCreated = await createTestApiToken(context, {
      name: "files-pkg-test-key-other",
      roleId: otherRoleId,
      email: "files-pkg-test-key-other@example.com",
    });
    otherApiKeyPlain = otherCreated.plainKey;
    otherApiKeyUserId = otherCreated.userId;

    const publicFile = await context.filesAdmin.upload({
      content: Buffer.from("public content"),
      filename: "files-pkg-test-public.txt",
      declaredContentType: "text/plain",
      visibility: "PUBLIC",
    });
    publicFileId = publicFile.id;

    const privateFile = await context.filesAdmin.upload({
      content: Buffer.from("private content"),
      filename: "files-pkg-test-private.txt",
      declaredContentType: "text/plain",
      visibility: "PRIVATE",
    });
    privateFileId = privateFile.id;
  });

  afterAll(async () => {
    await context.filesAdmin.remove(publicFileId).catch(() => undefined);
    await context.filesAdmin.remove(privateFileId).catch(() => undefined);
    await database.query(`DELETE FROM totalbase.permissions WHERE role = ANY($1)`, [[roleId, otherRoleId]]);
    await database.query(`DELETE FROM totalbase.users WHERE id = ANY($1)`, [[apiKeyUserId, otherApiKeyUserId]]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = ANY($1)`, [[roleId, otherRoleId]]);
    await app.close();
    await database.close();
  });

  it("serves a PUBLIC file's content with no auth at all", async () => {
    const res = await app.inject({ method: "GET", url: `/api/totalbase/table/files/${publicFileId}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("public content");
  });

  it("denies a PRIVATE file with no grant, then allows it once READ is granted", async () => {
    const denied = await app.inject({
      method: "GET",
      url: `/api/totalbase/table/files/${privateFileId}`,
      headers: { authorization: `Bearer ${apiKeyPlain}` },
    });
    expect(denied.statusCode).toBe(403);

    await context.permissions.set(roleId, filesResourceId, "READ", { effect: "ALLOW" });

    const allowed = await app.inject({
      method: "GET",
      url: `/api/totalbase/table/files/${privateFileId}`,
      headers: { authorization: `Bearer ${apiKeyPlain}` },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body).toBe("private content");

    await context.permissions.delete(roleId, filesResourceId, "READ");
  });

  it("rejects a PRIVATE file with no bearer token at all", async () => {
    const res = await app.inject({ method: "GET", url: `/api/totalbase/table/files/${privateFileId}` });
    expect(res.statusCode).toBe(401);
  });

  it("enforces a row filter: a role scoped by created_by = $USER.id can't read another user's file (token principals resolve $USER.*)", async () => {
    // Both callers are API tokens: $USER.* resolves the token owner's row
    // exactly as for a session (Specification_Security.md §6.6).
    await context.permissions.set(roleId, filesResourceId, "READ", { effect: "ALLOW", where: { created_by: { _eq: "$USER.id" } } });
    await context.permissions.set(otherRoleId, filesResourceId, "READ", { effect: "ALLOW", where: { created_by: { _eq: "$USER.id" } } });

    const own = await context.filesAdmin.upload({
      content: Buffer.from("owned by role A"),
      filename: "files-pkg-test-owned-a.txt",
      declaredContentType: "text/plain",
      visibility: "PRIVATE",
      actorUserId: apiKeyUserId,
    });

    const sameOwner = await app.inject({
      method: "GET",
      url: `/api/totalbase/table/files/${own.id}`,
      headers: { authorization: `Bearer ${apiKeyPlain}` },
    });
    expect(sameOwner.statusCode).toBe(200);

    const otherOwner = await app.inject({
      method: "GET",
      url: `/api/totalbase/table/files/${own.id}`,
      headers: { authorization: `Bearer ${otherApiKeyPlain}` },
    });
    expect(otherOwner.statusCode).toBe(403);

    await context.filesAdmin.remove(own.id);
    await context.permissions.delete(roleId, filesResourceId, "READ");
    await context.permissions.delete(otherRoleId, filesResourceId, "READ");
  });

  it("records a token upload's created_by as the token owner's user id, so a $USER.id row filter reads it back (regression: was the token id)", async () => {
    await context.permissions.set(roleId, filesResourceId, "CREATE", { effect: "ALLOW" });
    await context.permissions.set(roleId, filesResourceId, "READ", { effect: "ALLOW", where: { created_by: { _eq: "$USER.id" } } });

    const form = new FormData();
    form.append("file", new Blob([Buffer.from("token owner upload")], { type: "text/plain" }), "files-pkg-test-token-owner.txt");
    const uploaded = await app.inject({
      method: "POST",
      url: `/api/totalbase/table/files`,
      headers: { authorization: `Bearer ${apiKeyPlain}` },
      payload: form,
    });
    expect(uploaded.statusCode).toBe(201);
    const uploadedId = uploaded.json().data.id as string;
    try {
      const { rows } = await database.query<{ created_by: string }>(`SELECT created_by FROM totalbase.files WHERE id = $1`, [uploadedId]);
      expect(rows[0]!.created_by).toBe(apiKeyUserId);

      const readBack = await app.inject({
        method: "GET",
        url: `/api/totalbase/table/files/${uploadedId}`,
        headers: { authorization: `Bearer ${apiKeyPlain}` },
      });
      expect(readBack.statusCode).toBe(200);
      expect(readBack.body).toBe("token owner upload");
    } finally {
      await context.filesAdmin.remove(uploadedId);
      await context.permissions.delete(roleId, filesResourceId, "CREATE");
      await context.permissions.delete(roleId, filesResourceId, "READ");
    }
  });

  it("denies CREATE with no grant, then allows an upload once granted", async () => {
    const denied = await app.inject({
      method: "POST",
      url: `/api/totalbase/table/files`,
      headers: { authorization: `Bearer ${apiKeyPlain}` },
    });
    expect(denied.statusCode).toBe(403);

    await context.permissions.set(roleId, filesResourceId, "CREATE", { effect: "ALLOW" });

    const form = new FormData();
    form.append("file", new Blob([Buffer.from("uploaded via api")], { type: "text/plain" }), "files-pkg-test-upload.txt");

    const allowed = await app.inject({
      method: "POST",
      url: `/api/totalbase/table/files`,
      headers: { authorization: `Bearer ${apiKeyPlain}` },
      payload: form,
    });
    expect(allowed.statusCode).toBe(201);
    const uploadedId = allowed.json().data.id as string;
    expect(allowed.json().data).not.toHaveProperty("storage_key");
    expect(allowed.json().data).not.toHaveProperty("storage_provider");

    await context.filesAdmin.remove(uploadedId);
    await context.permissions.delete(roleId, filesResourceId, "CREATE");
  });

  it("never returns where a file is stored, from any Files route", async () => {
    await context.permissions.set(roleId, filesResourceId, "READ", { effect: "ALLOW" });
    await context.permissions.set(roleId, filesResourceId, "UPDATE", { effect: "ALLOW", fields: [{ field: "description", effect: "ALLOW" }] });
    try {
      const headers = { authorization: `Bearer ${apiKeyPlain}` };
      const info = await app.inject({ method: "GET", url: `/api/totalbase/table/files/${privateFileId}/info`, headers });
      const patched = await app.inject({
        method: "PATCH",
        url: `/api/totalbase/table/files/${privateFileId}`,
        headers,
        payload: { data: { description: "no storage details" } },
      });
      for (const res of [info, patched]) {
        expect(res.statusCode).toBe(200);
        expect(res.json().data.id).toBe(privateFileId);
        expect(res.json().data).not.toHaveProperty("storage_key");
        expect(res.json().data).not.toHaveProperty("storage_provider");
      }
    } finally {
      await context.permissions.delete(roleId, filesResourceId, "READ");
      await context.permissions.delete(roleId, filesResourceId, "UPDATE");
    }
  });
  it("authorizes a metadata update on the file before AND after it, and only granted columns (regression: was OLD-only)", async () => {
    // Editors may touch PRIVATE files only, and only their description.
    await context.permissions.set(roleId, filesResourceId, "UPDATE", {
      effect: "ALLOW",
      where: { visibility: { _eq: "PRIVATE" } },
      fields: [{ field: "description", effect: "ALLOW" }, { field: "visibility", effect: "ALLOW" }],
    });
    try {
      const headers = { authorization: `Bearer ${apiKeyPlain}` };
      const patch = (payload: Record<string, unknown>) =>
        app.inject({ method: "PATCH", url: `/api/totalbase/table/files/${privateFileId}`, headers, payload: { data: payload } });

      // NEW would leave the filter: refused, and rolled back.
      expect((await patch({ visibility: "PUBLIC" })).statusCode).toBe(403);
      expect((await context.filesAdmin.get(privateFileId)).visibility).toBe("PRIVATE");
      // A column without a field grant.
      expect((await patch({ tags: ["x"] })).statusCode).toBe(403);
      // OLD outside the filter.
      const outside = await app.inject({ method: "PATCH", url: `/api/totalbase/table/files/${publicFileId}`, headers, payload: { data: { description: "no" } } });
      expect(outside.statusCode).toBe(403);
      // Inside both.
      const ok = await patch({ description: "edited" });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().data.description).toBe("edited");
    } finally {
      await context.permissions.delete(roleId, filesResourceId, "UPDATE");
    }
  });

  it("renames and moves a file through the metadata PATCH, authorized like any metadata change", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const folders = await database.query<{ id: string }>(
      `INSERT INTO totalbase.folders (name) VALUES ($1), ($2) RETURNING id`,
      [`rename-a-${suffix}`, `rename-b-${suffix}`],
    );
    const [folderA, folderB] = folders.rows.map((row) => row.id) as [string, string];
    const original = await context.filesAdmin.get(privateFileId);
    await context.filesAdmin.updateMetadata(privateFileId, { folder: folderA });
    const headers = { authorization: `Bearer ${apiKeyPlain}` };
    const patch = (payload: Record<string, unknown>) =>
      app.inject({ method: "PATCH", url: `/api/totalbase/table/files/${privateFileId}`, headers, payload: { data: payload } });
    try {
      // Field grants on name and folder, rows limited to folder A.
      await context.permissions.set(roleId, filesResourceId, "UPDATE", {
        effect: "ALLOW",
        where: { folder: { _eq: folderA } },
        fields: [{ field: "name", effect: "ALLOW" }, { field: "folder", effect: "ALLOW" }],
      });
      // Rename: trimmed like an upload; the extension follows the name.
      const renamed = await patch({ name: "  notes.md  " });
      expect(renamed.statusCode, renamed.body).toBe(200);
      expect(renamed.json().data).toMatchObject({ name: "notes.md", extension: "md", folder: folderA });
      expect(renamed.json().data).not.toHaveProperty("storage_key");
      // A move out of the row filter: refused, and rolled back.
      expect((await patch({ folder: folderB })).statusCode).toBe(403);
      expect((await context.filesAdmin.get(privateFileId)).folder).toBe(folderA);
      // PostgreSQL's name CHECK, in words.
      const blank = await patch({ name: "   " });
      expect(blank.json().errors[0]).toMatchObject({ code: "CHECK_VIOLATION", message: "A file needs a name.", field: "name" });

      // Without a row filter: the target folder must exist - the foreign key decides.
      await context.permissions.set(roleId, filesResourceId, "UPDATE", {
        effect: "ALLOW",
        fields: [{ field: "name", effect: "ALLOW" }, { field: "folder", effect: "ALLOW" }],
      });
      const missing = await patch({ folder: "00000000-0000-4000-8000-000000000000" });
      expect(missing.statusCode, missing.body).toBe(409);
      expect(missing.json().errors[0]).toMatchObject({ code: "FOREIGN_KEY_VIOLATION", message: "The target folder doesn't exist.", field: "folder" });
      const moved = await patch({ folder: folderB });
      expect(moved.statusCode, moved.body).toBe(200);
      expect(moved.json().data.folder).toBe(folderB);
      const toRoot = await patch({ folder: null });
      expect(toRoot.statusCode, toRoot.body).toBe(200);
      expect(toRoot.json().data.folder).toBeNull();

      // A column without a field grant.
      await context.permissions.set(roleId, filesResourceId, "UPDATE", { effect: "ALLOW", fields: [{ field: "description", effect: "ALLOW" }] });
      expect((await patch({ name: "nope.txt" })).statusCode).toBe(403);
      expect((await patch({ folder: folderA })).statusCode).toBe(403);
    } finally {
      await context.permissions.delete(roleId, filesResourceId, "UPDATE");
      await context.filesAdmin.updateMetadata(privateFileId, { name: original.name, folder: null });
      await database.query(`DELETE FROM totalbase.folders WHERE id = ANY($1)`, [[folderA, folderB]]);
    }
  });

  it("replaces a file's content for a caller granted UPDATE on it", async () => {
    const headers = { authorization: `Bearer ${apiKeyPlain}` };
    const put = () => app.inject({ method: "PUT", url: `/api/totalbase/table/files/${privateFileId}/content`, headers, payload: { data: { content: "new private content" } } });
    expect((await put()).statusCode).toBe(403);
    await context.permissions.set(roleId, filesResourceId, "UPDATE", { effect: "ALLOW" });
    try {
      const res = await put();
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data).not.toHaveProperty("storage_key");
      expect((await context.filesAdmin.readContent(privateFileId)).content.toString()).toBe("new private content");
    } finally {
      await context.permissions.delete(roleId, filesResourceId, "UPDATE");
    }
  });
});
