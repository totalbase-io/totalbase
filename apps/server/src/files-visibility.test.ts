import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { adminToken, createTestApiToken, setupTestApp, uniqueSuffix } from "./test-support.js";

/**
 * A file's visibility as the ceiling of every grant on files (Administration.md §10.6): PRIVATE reaches its uploader
 * only, LINKED also whoever may read a row that references it, PUBLIC anyone by its id - and no list hands out a
 * file the caller can't reach. The security lab's finding: every App user listed and read every PRIVATE file.
 */
describe("file visibility", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  const suffix = uniqueSuffix();
  const table = `fv_cases_${suffix}`;
  let filesResource: string;
  let casesResource: string;
  const roles: string[] = [];
  const users: string[] = [];
  let owner: { token: string; id: string };
  let reader: { token: string; id: string };
  let blind: { token: string; id: string };
  const files: Record<string, string> = {};

  const as = (token: string | undefined, method: "GET" | "PATCH" | "DELETE", url: string, data?: unknown) =>
    app.inject({ method, url, ...(token && { headers: { authorization: `Bearer ${token}` } }), ...(data !== undefined && { payload: { data } }) });
  const listed = async (token: string) => {
    const response = await as(token, "GET", `/api/totalbase/table/files?fields=id&limit=500`);
    if (response.statusCode !== 200) throw new Error(`files list -> ${response.statusCode} ${response.body}`);
    return (response.json().data as { id: string }[]).map((file) => file.id);
  };

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    filesResource = (await database.query<{ id: string }>(`SELECT id FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = 'files'`)).rows[0]!.id;
    await database.query(`CREATE TABLE public.${table} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), restricted boolean NOT NULL, note text, photo uuid REFERENCES totalbase.files)`);
    casesResource = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', ARRAY['GET']) RETURNING id`,
      [`public.${table}`, table],
    )).rows[0]!.id;

    const person = async (name: string, grants: (role: string) => Promise<void>) => {
      const role = (await context.roles.create(`fv-${name}-${suffix}`, { apiAccess: true })).id;
      roles.push(role);
      await grants(role);
      const created = await createTestApiToken(context, { name: `fv-${name}`, roleId: role, email: `fv-${name}-${suffix}@example.com` });
      users.push(created.userId);
      return { token: created.plainKey, id: created.userId };
    };
    // Every one of them reads and changes files with no row filter at all: only the visibility holds them.
    const allow = (...names: string[]) => names.map((field) => ({ field, effect: "ALLOW" as const }));
    const fileFields = allow("id", "name", "folder", "visibility", "description", "tags", "created_by", "mime_type", "size_bytes");
    const filesGrants = async (role: string) => {
      for (const action of ["CREATE", "READ", "UPDATE", "DELETE"] as const) await context.permissions.set(role, filesResource, action, { effect: "ALLOW", fields: fileFields });
    };
    owner = await person("owner", filesGrants);
    reader = await person("reader", async (role) => {
      await filesGrants(role);
      await context.permissions.set(role, casesResource, "READ", { effect: "ALLOW", where: { restricted: { _eq: false } }, fields: allow("id", "restricted", "photo") });
    });
    // Reads the cases, but not their photo column.
    blind = await person("blind", async (role) => {
      await filesGrants(role);
      await context.permissions.set(role, casesResource, "READ", { effect: "ALLOW", fields: allow("id", "restricted") });
    });

    const upload = async (key: string, visibility: "PRIVATE" | "LINKED" | "PUBLIC") => {
      files[key] = (await context.filesAdmin.upload({ content: Buffer.from(key), filename: `${key}.txt`, declaredContentType: "text/plain", visibility, actorUserId: owner.id })).id;
    };
    await upload("private", "PRIVATE");
    await upload("linkedOpen", "LINKED");
    await upload("linkedRestricted", "LINKED");
    await upload("linkedLoose", "LINKED");
    await upload("publicLoose", "PUBLIC");
    await upload("publicOpen", "PUBLIC");
    await database.query(
      `INSERT INTO public.${table} (restricted, photo) VALUES (false, $1), (true, $2), (false, $3), (false, $4)`,
      [files.linkedOpen, files.linkedRestricted, files.private, files.publicOpen],
    );
  });

  afterAll(async () => {
    await database.query(`DROP TABLE IF EXISTS public.${table}`);
    for (const id of Object.values(files)) await context.filesAdmin.remove(id).catch(() => undefined);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [casesResource]);
    await database.query(`DELETE FROM totalbase.users WHERE id = ANY($1)`, [users]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = ANY($1)`, [roles]);
    await app.close();
  });

  it("lists to each caller only what they reach: their own, and what a row they read links", async () => {
    expect(await listed(owner.token)).toEqual(expect.arrayContaining(Object.values(files)));
    const seen = await listed(reader.token);
    expect(seen).toEqual(expect.arrayContaining([files.linkedOpen, files.publicOpen]));
    for (const key of ["private", "linkedRestricted", "linkedLoose", "publicLoose"]) expect(seen, key).not.toContain(files[key]);
    // A file column the caller can't read links nothing for them.
    const blindSeen = await listed(blind.token);
    for (const id of Object.values(files)) expect(blindSeen).not.toContain(id);
    // A record read by key is held to it too.
    expect((await as(reader.token, "GET", `/api/totalbase/table/files?where[id][_eq]=${files.private}`)).json().data).toEqual([]);
    // An administrator isn't held to it.
    expect(await listed(await adminToken(context))).toEqual(expect.arrayContaining(Object.values(files)));
  });

  it("serves content the same way: by link for LINKED, never for another's PRIVATE, to anyone for PUBLIC", async () => {
    const content = (token: string | undefined, key: string) => as(token, "GET", `/api/totalbase/table/files/${files[key]}`);
    expect((await content(reader.token, "linkedOpen")).statusCode).toBe(200);
    expect((await content(reader.token, "linkedRestricted")).statusCode).toBe(403);
    expect((await content(reader.token, "linkedLoose")).statusCode).toBe(403);
    // Linked from a row the reader reads, but PRIVATE: never through a link.
    expect((await content(reader.token, "private")).statusCode).toBe(403);
    expect((await content(blind.token, "linkedOpen")).statusCode).toBe(403);
    expect((await content(owner.token, "private")).statusCode).toBe(200);
    // PUBLIC: its content by id, with no credentials - but no list hands the id out.
    expect((await content(undefined, "publicLoose")).statusCode).toBe(200);
  });

  it("holds writes to it before and after: no reaching another's PRIVATE file, no taking a file out of reach", async () => {
    expect((await as(reader.token, "PATCH", `/api/totalbase/table/files/${files.private}`, { description: "x" })).statusCode).toBe(403);
    expect((await as(reader.token, "DELETE", `/api/totalbase/table/files/${files.private}`)).statusCode).toBe(403);
    expect((await as(reader.token, "PATCH", `/api/totalbase/table/files/${files.linkedOpen}`, { description: "seen" })).statusCode).toBe(200);
    // Making the owner's LINKED file PRIVATE would take it out of the reader's reach: refused, and rolled back.
    expect((await as(reader.token, "PATCH", `/api/totalbase/table/files/${files.linkedOpen}`, { visibility: "PRIVATE" })).statusCode).toBe(403);
    expect((await database.query(`SELECT visibility FROM totalbase.files WHERE id = $1`, [files.linkedOpen])).rows[0]!.visibility).toBe("LINKED");
    // Its uploader may.
    expect((await as(owner.token, "PATCH", `/api/totalbase/table/files/${files.linkedLoose}`, { visibility: "PRIVATE" })).statusCode).toBe(200);
  });

  it("lets only the uploader or an administrator set a visibility - Public only while uploaders may publish", async () => {
    const patch = (token: string, key: string, visibility: string) => as(token, "PATCH", `/api/totalbase/table/files/${files[key]}`, { visibility });
    // Someone else who reaches the file sees it, and may change its details, but never who else sees it.
    expect((await patch(reader.token, "linkedOpen", "PUBLIC")).statusCode).toBe(403);
    expect((await patch(reader.token, "linkedOpen", "LINKED")).statusCode).toBe(200); // unchanged: nothing to decide
    expect((await patch(owner.token, "linkedOpen", "PUBLIC")).statusCode).toBe(200);
    expect((await patch(owner.token, "linkedOpen", "LINKED")).statusCode).toBe(200);
    try {
      await context.settings.set("files.uploader_can_publish", false);
      expect((await patch(owner.token, "linkedOpen", "PUBLIC")).statusCode).toBe(403);
      expect((await patch(owner.token, "linkedOpen", "PRIVATE")).statusCode).toBe(200);
      expect((await patch(owner.token, "linkedOpen", "LINKED")).statusCode).toBe(200);
      // Nor at upload.
      const boundary = "fvpublish";
      const body = [`--${boundary}`, 'Content-Disposition: form-data; name="visibility"', "", "PUBLIC", `--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="p.txt"', "Content-Type: text/plain", "", "p", `--${boundary}--`, ""].join("\r\n");
      const upload = await app.inject({ method: "POST", url: "/api/totalbase/table/files", headers: { authorization: `Bearer ${owner.token}`, "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
      expect(upload.statusCode).toBe(403);
      // An administrator still may.
      expect((await patch(await adminToken(context), "linkedOpen", "PUBLIC")).statusCode).toBe(200);
      expect((await patch(await adminToken(context), "linkedOpen", "LINKED")).statusCode).toBe(200);
    } finally {
      await context.settings.reset("files.uploader_can_publish");
    }
  });

  it("audits who opened which file when files' read audit is on", async () => {
    await database.query(`UPDATE totalbase.resources SET audit_read = true WHERE id = $1`, [filesResource]);
    try {
      expect((await as(reader.token, "GET", `/api/totalbase/table/files/${files.linkedOpen}`)).statusCode).toBe(200);
      expect((await as(reader.token, "GET", `/api/totalbase/table/files/${files.linkedOpen}/info`)).statusCode).toBe(200);
      expect((await as(reader.token, "GET", `/api/totalbase/table/files/${files.private}`)).statusCode).toBe(403);
      const { rows } = await database.query<{ status: string; metadata: { pk: string; content?: boolean } }>(
        `SELECT status, metadata FROM totalbase.logs WHERE resource = $1 AND action = 'READ' AND metadata->>'pk' = ANY($2) ORDER BY created_at`,
        [filesResource, [files.linkedOpen, files.private]],
      );
      expect(rows.map((row) => [row.status, row.metadata.pk, row.metadata.content])).toEqual([
        ["EXECUTED", files.linkedOpen, true],
        ["EXECUTED", files.linkedOpen, false],
        ["DENIED", files.private, true],
      ]);
    } finally {
      await database.query(`UPDATE totalbase.resources SET audit_read = false WHERE id = $1`, [filesResource]);
      await database.query(`DELETE FROM totalbase.logs WHERE resource = $1 AND action = 'READ'`, [filesResource]);
    }
  });

  it("follows the row's own filter as it changes: a row that leaves the reader's scope takes its file along", async () => {
    await database.query(`UPDATE public.${table} SET restricted = true WHERE photo = $1`, [files.publicOpen]);
    expect(await listed(reader.token)).not.toContain(files.publicOpen);
    await database.query(`UPDATE public.${table} SET restricted = false WHERE photo = $1`, [files.publicOpen]);
    expect(await listed(reader.token)).toContain(files.publicOpen);
  });

  it("refuses an upload with a visibility it doesn't know", async () => {
    const boundary = "fvboundary";
    const body = [`--${boundary}`, 'Content-Disposition: form-data; name="visibility"', "", "SHARED", `--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="x.txt"', "Content-Type: text/plain", "", "x", `--${boundary}--`, ""].join("\r\n");
    const response = await app.inject({ method: "POST", url: "/api/totalbase/table/files", headers: { authorization: `Bearer ${owner.token}`, "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(response.statusCode).toBe(400);
  });
});
