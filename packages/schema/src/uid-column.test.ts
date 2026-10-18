import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TableSchemaService } from "./table-schema-service.js";

const TABLE = "schema_pkg_test_uid";

/** The UID column type (Specification_DataViews.md §16.3): PostgreSQL generates the slug, whoever writes the row. */
describe("UID columns (integration)", () => {
  let database: Database;
  let schemaService: TableSchemaService;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    schemaService = new TableSchemaService(database);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
    await schemaService.createTable({
      schema: "public",
      name: TABLE,
      columns: [
        { name: "id", dataType: "integer", nullable: false, primaryKey: true },
        { name: "title", dataType: "text" },
      ],
    });
  });

  afterAll(async () => {
    await database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
    await database.close();
  });

  async function slugOf(id: number): Promise<string | null> {
    const { rows } = await database.query<{ slug: string | null }>(`SELECT slug FROM public.${TABLE} WHERE id = $1`, [id]);
    return rows[0]!.slug;
  }

  it("adds the column, its UNIQUE and its trigger in one transaction, the trigger recorded with the DDL", async () => {
    const recorded: string[] = [];
    await schemaService.addColumn("public", TABLE, { name: "slug", dataType: "text", unique: true, uid: { source: "title" } }, undefined, async (_client, record) => {
      recorded.push(...record.statements);
    });
    expect(recorded.some((sql) => sql.startsWith("CREATE TRIGGER") && sql.includes("totalbase.set_uid"))).toBe(true);
  });

  it("fills an empty UID with the source's slug, appends -2 when taken, and keeps a value given explicitly", async () => {
    await database.query(`INSERT INTO public.${TABLE} (id, title) VALUES (1, 'Mi primer  Artículo!'), (2, 'Mi primer artículo')`);
    expect(await slugOf(1)).toBe("mi-primer-articulo");
    expect(await slugOf(2)).toBe("mi-primer-articulo-2");

    await database.query(`INSERT INTO public.${TABLE} (id, title, slug) VALUES (3, 'Other', 'custom-slug')`);
    expect(await slugOf(3)).toBe("custom-slug");

    await database.query(`INSERT INTO public.${TABLE} (id, title) VALUES (4, NULL), (5, '¡¿!')`);
    expect(await slugOf(4)).toBeNull();
    expect(await slugOf(5)).toBeNull();

    // An update that empties it generates it again; one that keeps it leaves it alone.
    await database.query(`UPDATE public.${TABLE} SET title = 'Renamed' WHERE id = 3`);
    expect(await slugOf(3)).toBe("custom-slug");
    await database.query(`UPDATE public.${TABLE} SET slug = NULL WHERE id = 3`);
    expect(await slugOf(3)).toBe("renamed");
  });

  it("keeps working after either column is renamed (attnums, not names)", async () => {
    await schemaService.alterColumn("public", TABLE, "title", { rename: "heading" });
    await schemaService.alterColumn("public", TABLE, "slug", { rename: "handle" });
    await database.query(`INSERT INTO public.${TABLE} (id, heading) VALUES (6, 'After rename')`);
    const { rows } = await database.query<{ handle: string }>(`SELECT handle FROM public.${TABLE} WHERE id = 6`);
    expect(rows[0]!.handle).toBe("after-rename");
    await schemaService.alterColumn("public", TABLE, "heading", { rename: "title" });
    await schemaService.alterColumn("public", TABLE, "handle", { rename: "slug" });
  });

  it("rejects an unknown source or the column itself, adding nothing", async () => {
    await expect(schemaService.addColumn("public", TABLE, { name: "code", dataType: "text", uid: { source: "missing" } }))
      .rejects.toMatchObject({ code: "UNDEFINED_COLUMN" });
    await expect(schemaService.addColumn("public", TABLE, { name: "code", dataType: "text", uid: { source: "code" } }))
      .rejects.toMatchObject({ code: "INVALID_SCHEMA_OPERATION" });
    const { rows } = await database.query(`SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'code'`, [TABLE]);
    expect(rows).toHaveLength(0);
  });

  it("dropping the UID column drops its trigger", async () => {
    await schemaService.dropColumn("public", TABLE, "slug");
    const { rows } = await database.query(`SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.${TABLE}'::regclass AND NOT tgisinternal`);
    expect(rows).toHaveLength(0);
    await database.query(`INSERT INTO public.${TABLE} (id, title) VALUES (7, 'No trigger left')`);
  });
});
