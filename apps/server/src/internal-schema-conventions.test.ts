import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { setupTestApp } from "./test-support.js";

/**
 * The internal schema follows its own conventions (Specification.md §9,
 * AGENTS.md §10), checked against PostgreSQL's catalog so a new migration
 * that breaks one fails here.
 */
describe("internal schema conventions (integration)", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  async function tables(): Promise<string[]> {
    const { rows } = await database.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c WHERE c.relnamespace = 'totalbase'::regnamespace AND c.relkind IN ('r', 'p') ORDER BY 1`,
    );
    return rows.map((row) => row.name);
  }

  it("names every table without a prefix - the schema is the namespace - and every word plural (§9.1)", async () => {
    // Words that are not plural nouns: a modifier (cron, sql) and the collective
    // mechanisms §9.1 names as exceptions.
    const SINGULAR_WORDS = new Set(["cron", "sql", "instance", "outbox", "idempotency"]);
    const offenders = (await tables()).filter((name) =>
      name.startsWith("totalbase_") || name.split("_").some((word) => !word.endsWith("s") && !SINGULAR_WORDS.has(word)));
    expect(offenders).toEqual([]);
  });

  it("gives every table a single uuid `id` primary key defaulting to gen_random_uuid() (§9.2)", async () => {
    const { rows } = await database.query<{ name: string; pk: string | null }>(
      `SELECT c.relname AS name,
              (SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), ''), ',')
               FROM pg_constraint k
               JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
               LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
               WHERE k.conrelid = c.oid AND k.contype = 'p') AS pk
       FROM pg_class c
       WHERE c.relnamespace = 'totalbase'::regnamespace AND c.relkind IN ('r', 'p')`,
    );
    expect(rows.filter((row) => row.pk !== "id:uuid:gen_random_uuid()")).toEqual([]);
  });

  it("names no foreign-key column with an `_id` suffix (§9.2)", async () => {
    const { rows } = await database.query<{ column: string }>(
      `SELECT c.relname || '.' || a.attname AS column
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
       WHERE k.contype = 'f' AND c.relnamespace = 'totalbase'::regnamespace AND a.attname LIKE '%\\_id'`,
    );
    expect(rows).toEqual([]);
  });

  it("stores instants as timestamptz (§9.2)", async () => {
    const { rows } = await database.query<{ column: string }>(
      `SELECT c.relname || '.' || a.attname AS column
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
       WHERE c.relnamespace = 'totalbase'::regnamespace AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
         AND a.atttypid IN ('timestamp'::regtype, 'timetz'::regtype, 'time'::regtype)`,
    );
    expect(rows).toEqual([]);
  });

  it("constrains every status column to uppercase states (§9.2)", async () => {
    const { rows } = await database.query<{ name: string; definition: string }>(
      `SELECT k.conname AS name, pg_get_constraintdef(k.oid) AS definition
       FROM pg_constraint k
       JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
       WHERE k.contype = 'c' AND k.connamespace = 'totalbase'::regnamespace AND a.attname = 'status'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    const lowercase = rows.filter((row) => /'[^']*[a-z][^']*'::text/.test(row.definition));
    expect(lowercase).toEqual([]);
  });

  it("leaves no object of the totalbase schema with the old totalbase_ prefix (§9.1)", async () => {
    const { rows } = await database.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c WHERE c.relnamespace = 'totalbase'::regnamespace AND c.relname LIKE 'totalbase\\_%'
       UNION ALL SELECT k.conname FROM pg_constraint k WHERE k.connamespace = 'totalbase'::regnamespace AND k.conname LIKE 'totalbase\\_%'
       UNION ALL SELECT p.proname FROM pg_proc p WHERE p.pronamespace = 'totalbase'::regnamespace AND p.proname LIKE 'totalbase\\_%'
       UNION ALL SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         WHERE c.relnamespace = 'totalbase'::regnamespace AND t.tgname LIKE 'totalbase\\_%'`,
    );
    expect(rows).toEqual([]);
  });

  it("caps a workflow's name, description and slug in PostgreSQL (§9.3)", async () => {
    const insert = (name: string, description: string | null, slug: string) =>
      database.query(
        `INSERT INTO totalbase.workflows (name, description, slug, definition) VALUES ($1, $2, $3, '{}'::jsonb) RETURNING id`,
        [name, description, slug],
      );
    await expect(insert("x".repeat(33), null, "conventions-test-a")).rejects.toMatchObject({ code: "CHECK_VIOLATION" });
    await expect(insert("Conventions test b", "d".repeat(129), "conventions-test-b")).rejects.toMatchObject({ code: "CHECK_VIOLATION" });
    await expect(insert("Conventions test c", null, "s".repeat(33))).rejects.toMatchObject({ code: "CHECK_VIOLATION" });
  });

  it("records a file's author as a user, set by PostgreSQL from the actor (created_by once, updated_by on every write)", async () => {
    const author = await context.auth.users.create({ email: `conventions-file-author-${Date.now()}@example.com`, name: "Author" });
    const editor = await context.auth.users.create({ email: `conventions-file-editor-${Date.now()}@example.com`, name: "Editor" });
    let fileId: string | undefined;
    try {
      const file = await context.filesAdmin.upload({
        content: Buffer.from("hello"),
        filename: "conventions.txt",
        declaredContentType: "text/plain",
        actorUserId: author.id,
      });
      fileId = file.id;
      expect(file).toMatchObject({ created_by: author.id, updated_by: author.id });

      // A write in a transaction whose actor is someone else: updated_by
      // follows, created_by never changes - even when the statement names it.
      await database.transaction(async (client) => {
        await client.query(`UPDATE totalbase.files SET description = 'edited', created_by = $2 WHERE id = $1`, [file.id, editor.id]);
      }, { actorUserId: editor.id });
      const { rows } = await database.query<{ created_by: string; updated_by: string }>(
        `SELECT created_by, updated_by FROM totalbase.files WHERE id = $1`,
        [file.id],
      );
      expect(rows[0]).toEqual({ created_by: author.id, updated_by: editor.id });

      // Not a user id (e.g. a token id): the foreign key refuses it.
      await expect(
        database.transaction(async (client) => {
          await client.query(`UPDATE totalbase.files SET description = 'x' WHERE id = $1`, [file.id]);
        }, { actorUserId: "00000000-0000-0000-0000-000000000000" }),
      ).rejects.toMatchObject({ code: "FOREIGN_KEY_VIOLATION" });
    } finally {
      if (fileId) await context.filesAdmin.remove(fileId);
      await database.query(`DELETE FROM totalbase.users WHERE id = ANY($1::uuid[])`, [[author.id, editor.id]]);
    }
  });
});
