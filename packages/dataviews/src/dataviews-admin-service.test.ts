import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { runMigrations } from "@totalbase/migrations";
import { pushColumnPresentation } from "@totalbase/resources";
import { COLUMN_WIDGET_NAMES } from "@totalbase/tb-catalog";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataViewsAdminService } from "./dataviews-admin-service.js";
import { relationDetailCache } from "@totalbase/pg-catalog";

// Integration tests change tables with raw SQL (ALTER/RENAME/DROP COLUMN); in the product every schema change
// goes through a reconcile that clears the relation-detail cache, so here it is simply off.
relationDetailCache.enabled = false;

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));
const TABLE = "dataviews_admin_pkg_test_products";
const TARGET_TABLE = "dataviews_admin_pkg_test_categories";
const FUNCTION_NAME = "dataviews_admin_pkg_test_fn";

describe("DataViewsAdminService (integration)", () => {
  let database: Database;
  let dataviewsAdmin: DataViewsAdminService;
  let tableResourceId: string;
  let viewResourceId: string;
  let functionResourceId: string;
  let missingResourceId: string;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    dataviewsAdmin = new DataViewsAdminService(database);

    await database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
    await database.query(`DROP TABLE IF EXISTS public.${TARGET_TABLE} CASCADE`);
    await database.query(`DROP FUNCTION IF EXISTS public.${FUNCTION_NAME}()`);
    await database.query(`DROP VIEW IF EXISTS public.dataviews_admin_pkg_test_view CASCADE`);

    await database.query(`CREATE TABLE public.${TARGET_TABLE} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL)`);
    await database.query(`
      CREATE TABLE public.${TABLE} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        title text NOT NULL,
        price numeric(12,2) NOT NULL,
        in_stock boolean NOT NULL DEFAULT true,
        category_id uuid REFERENCES public.${TARGET_TABLE} (id),
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await database.query(`CREATE VIEW public.dataviews_admin_pkg_test_view AS SELECT id, title FROM public.${TABLE}`);
    await database.query(`CREATE FUNCTION public.${FUNCTION_NAME}() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$`);

    const oidOf = async (regclass: string) => {
      const { rows } = await database.query<{ oid: number }>(`SELECT $1::regclass::oid::int AS oid`, [regclass]);
      return rows[0]!.oid;
    };
    const functionOidOf = async (regprocedure: string) => {
      const { rows } = await database.query<{ oid: number }>(`SELECT $1::regprocedure::oid::int AS oid`, [regprocedure]);
      return rows[0]!.oid;
    };

    const insertResource = async (oid: number, name: string, type: "TABLE" | "VIEW" | "FUNCTION", status: "ACTIVE" | "MISSING" = "ACTIVE") => {
      const { rows } = await database.query<{ id: string }>(
        `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status)
         VALUES ($1, 'public', $2, $3, $4) RETURNING id`,
        [oid, name, type, status],
      );
      return rows[0]!.id;
    };

    tableResourceId = await insertResource(await oidOf(`public.${TABLE}`), TABLE, "TABLE");
    viewResourceId = await insertResource(await oidOf("public.dataviews_admin_pkg_test_view"), "dataviews_admin_pkg_test_view", "VIEW");
    functionResourceId = await insertResource(await functionOidOf(`public.${FUNCTION_NAME}()`), FUNCTION_NAME, "FUNCTION");
    missingResourceId = await insertResource(900301, "dataviews_admin_pkg_test_missing", "TABLE", "MISSING");
  });

  afterAll(async () => {
    // dataviews.source_resource is ON DELETE RESTRICT (Specification_DataViews.md §2.1: never
    // silently destroy a configured DataView) - every DataView created by
    // this suite must go first, or the resource deletes below fail loudly
    // exactly as designed.
    await database.query(`DELETE FROM totalbase.dataviews WHERE source_resource IS NULL AND slug IN ('some-frame', 'frame-target')`);
    await database.query(`DELETE FROM totalbase.dataviews WHERE source_resource IN ($1, $2, $3, $4)`, [
      tableResourceId,
      viewResourceId,
      functionResourceId,
      missingResourceId,
    ]);
    await database.query(`DELETE FROM totalbase.resources WHERE id IN ($1, $2, $3, $4)`, [
      tableResourceId,
      viewResourceId,
      functionResourceId,
      missingResourceId,
    ]);
    await database.query(`DROP TABLE IF EXISTS public.${TABLE} CASCADE`);
    await database.query(`DROP TABLE IF EXISTS public.${TARGET_TABLE} CASCADE`);
    await database.query(`DROP FUNCTION IF EXISTS public.${FUNCTION_NAME}()`);
    await database.query(`DROP VIEW IF EXISTS public.dataviews_admin_pkg_test_view CASCADE`);
    await database.close();
  });

  it("creates a TABLE DataView and auto-populates COLUMN fields from the source", async () => {
    const dataview = await dataviewsAdmin.create({
      name: "Products",
      sourceResourceId: tableResourceId,
      viewType: "TABLE",
    });
    expect(dataview.slug).toBe("products");
    expect(dataview.scope).toBe("LISTED");
    expect(dataview.sourceResource).toBe(tableResourceId);
    expect(dataview.sourceResourceSchema).toBe("public");
    expect(dataview.sourceResourceName).toBe(TABLE);

    // The grid's columns - its record form is a generated page of widgets beside them.
    const fields = (await dataviewsAdmin.listFields(dataview.id)).filter((f) => f.kind === "COLUMN");
    expect(fields.map((f) => f.columnName)).toEqual(["id", "title", "price", "in_stock", "category_id", "created_at"]);
    expect(fields.every((f) => f.kind === "COLUMN")).toBe(true);
    // Each the column input catalog's rule (Specification_DataViews.md §16.1): a numeric is a Number field (UInput),
    // a boolean a Switch, a text a Text - and a foreign key a Relation (searchable), never the plain uuid's UInput.
    expect(fields.find((f) => f.columnName === "price")?.widget).toBe("UInput");
    expect(fields.find((f) => f.columnName === "in_stock")?.widget).toBe("USwitch");
    expect(fields.find((f) => f.columnName === "title")?.widget).toBe("UInput");
    expect(fields.find((f) => f.columnName === "category_id")?.widget).toBe("USelectMenu");

    const bySlug = await dataviewsAdmin.getBySlug("products");
    expect(bySlug.id).toBe(dataview.id);
    expect(bySlug.sourceResourceType).toBe("TABLE");
    expect(bySlug.sourceResourcePrimaryKey).toEqual(["id"]);
  });

  it("shows a foreign key's column by the row it points at, once the Data API can read its table", async () => {
    // Its table isn't a readable resource yet: the column keeps its key.
    const before = await dataviewsAdmin.create({ name: "Products FK before", sourceResourceId: tableResourceId, viewType: "TABLE" });
    const plain = (await dataviewsAdmin.listFields(before.id)).find((f) => f.columnName === "category_id")!;
    expect(plain.config.display_field).toBeUndefined();

    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES ($1::regclass::oid, 'public', $2, 'TABLE', 'ACTIVE', ARRAY['GET']) RETURNING id`,
      [`public.${TARGET_TABLE}`, TARGET_TABLE],
    );
    try {
      const after = await dataviewsAdmin.create({ name: "Products FK after", sourceResourceId: tableResourceId, viewType: "TABLE" });
      const linked = (await dataviewsAdmin.listFields(after.id)).find((f) => f.columnName === "category_id")!;
      expect(linked.config).toMatchObject({ display_field: "name", display_field_target: { schema: "public", table: TARGET_TABLE, column: "id" } });
    } finally {
      await database.query(`DELETE FROM totalbase.dataviews WHERE source_resource = $1 AND slug LIKE 'products-fk-%'`, [tableResourceId]);
      await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [rows[0]!.id]);
    }
  });

  it("orders and colors a Kanban's or a Gantt's lanes by their table's position and color, and fills a Gantt's bars by its progress, when the tables have them", async () => {
    await database.query(`CREATE TABLE public.dvpkg_lane_status (id serial PRIMARY KEY, name text NOT NULL, position integer NOT NULL, color text NOT NULL)`);
    await database.query(`CREATE TABLE public.dvpkg_lane_tickets (id serial PRIMARY KEY, subject text NOT NULL, status integer NOT NULL REFERENCES public.dvpkg_lane_status (id), starts date, ends date, progress integer)`);
    const ids: string[] = [];
    try {
      for (const name of ["dvpkg_lane_status", "dvpkg_lane_tickets"]) {
        const { rows } = await database.query<{ id: string }>(
          `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
           VALUES ($1::regclass::oid, 'public', $2, 'TABLE', 'ACTIVE', ARRAY['GET']) RETURNING id`,
          [`public.${name}`, name],
        );
        ids.push(rows[0]!.id);
      }
      const board = await dataviewsAdmin.create({
        name: "Lanes board", sourceResourceId: ids[1]!, viewType: "KANBAN",
        viewConfig: { kanban_layout: { groupColumn: "status", titleFormula: "{{subject}}", laneOrder: [], laneOrderColumn: null, laneColorColumn: null } },
      });
      expect(board.viewConfig.kanban_layout).toMatchObject({ laneOrderColumn: "position", laneColorColumn: "color" });
      // What the author named stays.
      const named = await dataviewsAdmin.create({
        name: "Lanes board named", sourceResourceId: ids[1]!, viewType: "KANBAN",
        viewConfig: { kanban_layout: { groupColumn: "status", laneOrderColumn: "id", laneColorColumn: "name" } },
      });
      expect(named.viewConfig.kanban_layout).toMatchObject({ laneOrderColumn: "id", laneColorColumn: "name" });
      // A Gantt's lanes too, and its bars' progress.
      const timeline = await dataviewsAdmin.create({
        name: "Lanes timeline", sourceResourceId: ids[1]!, viewType: "GANTT",
        viewConfig: { gantt_layout: { startDateColumn: "starts", endDateColumn: "ends", groupColumn: "status", progressColumn: null } },
      });
      expect(timeline.viewConfig.gantt_layout).toMatchObject({ laneOrderColumn: "position", laneColorColumn: "color", progressColumn: "progress" });
    } finally {
      await database.query(`DELETE FROM totalbase.dataviews WHERE source_resource = ANY($1)`, [ids]);
      await database.query(`DELETE FROM totalbase.resources WHERE id = ANY($1)`, [ids]);
      await database.query(`DROP TABLE IF EXISTS public.dvpkg_lane_tickets, public.dvpkg_lane_status`);
    }
  });

  it("honors selectedColumns (the rest stay out of the DataView) and persists viewConfig", async () => {
    const dataview = await dataviewsAdmin.create({
      name: "Products Table",
      sourceResourceId: tableResourceId,
      viewType: "TABLE",
      selectedColumns: ["id", "title", "price"],
      viewConfig: { features: { search: true, filter: false, columnsToggle: true, export: false, print: false } },
    });
    expect(dataview.viewConfig).toEqual({
      features: { search: true, filter: false, columnsToggle: true, export: false, print: false },
      variables: expect.any(Array),
      last_attnum: expect.any(Number),
    });

    // A column left out gets no field - it's never read (Specification_DataViews.md §4.1).
    const fields = (await dataviewsAdmin.listFields(dataview.id)).filter((f) => f.kind === "COLUMN");
    expect(fields.map((f) => f.columnName).sort()).toEqual(["id", "price", "title"]);
    expect(fields.every((f) => f.visible)).toBe(true);
  });

  it("applies fieldOverrides (widget/help) per column and rejects an unknown widget - never a title of its own", async () => {
    const dataview = await dataviewsAdmin.create({
      name: "Products Overridden",
      sourceResourceId: tableResourceId,
      viewType: "TABLE",
      fieldOverrides: {
        created_at: { help: "When this row was first inserted." },
        title: { widget: "UTextarea" },
      },
    });
    const fields = await dataviewsAdmin.listFields(dataview.id);
    const createdAt = fields.find((f) => f.columnName === "created_at")!;
    // Its title is its table's column's (Specification_DataViews.md §15) - a DataView's column has none.
    expect(fields.filter((f) => f.kind === "COLUMN").every((f) => f.label === null)).toBe(true);
    expect(createdAt.dataType).toBe("timestamp with time zone");
    // `displayFormatKind`/`displayFormatTzAware` are auto-derived from the
    // column's own real Postgres type (display-format.ts), alongside
    // whatever the override explicitly set - created_at is a timestamptz.
    // `required` is the DB-derived NOT NULL lock create() seeds on every
    // non-nullable column (the same one the Design form re-derives live);
    // `dbDefault` - its DEFAULT now() fills it in when a new record leaves it empty.
    expect(createdAt.config).toEqual({
      required: true,
      dbDefault: true,
      displayFormatKind: "datetime",
      displayFormatTzAware: true,
    });
    // The help text is the record form field's - not the grid column's.
    const createdAtField = fields.find((f) => f.widget === "UFormField" && (f.config as { props?: { column?: string } }).props?.column === "created_at");
    expect((createdAtField?.config as { props?: { help?: string } } | undefined)?.props?.help).toBe("When this row was first inserted.");
    expect(fields.find((f) => f.columnName === "title")!.widget).toBe("UTextarea");
    // Untouched columns still get the catalog rule's default (a numeric: Number field), plus the
    // same auto-derived display-format classification every numeric column gets
    // (and the same NOT NULL `required` lock - price is NOT NULL).
    expect(fields.find((f) => f.columnName === "price")!.widget).toBe("UInput");
    expect(fields.find((f) => f.columnName === "price")!.config).toEqual({ required: true, displayFormatKind: "number" });

    await expect(
      dataviewsAdmin.create({
        name: "Products Bad Widget",
        sourceResourceId: tableResourceId,
        viewType: "TABLE",
        fieldOverrides: { title: { widget: "NotARealWidget" } },
      }),
    ).rejects.toMatchObject({ code: "DATAVIEW_FIELD_WIDGET_INVALID" });
  });

  it("list() omits sourceResourcePrimaryKey (no catalog round trip per row)", async () => {
    const list = await dataviewsAdmin.list();
    expect(list.every((d) => d.sourceResourcePrimaryKey === undefined)).toBe(true);
  });

  it("listFields() 404s for an unknown DataView", async () => {
    await expect(dataviewsAdmin.listFields("00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({
      code: "DATAVIEW_NOT_FOUND",
    } satisfies Partial<TotalBaseError>);
  });

  it("accepts a VIEW as a source", async () => {
    const dataview = await dataviewsAdmin.create({
      name: "Products View",
      sourceResourceId: viewResourceId,
      viewType: "TABLE",
    });
    expect(dataview.sourceResource).toBe(viewResourceId);
  });

  it("rejects a FUNCTION source (Specification_DataViews.md §1.2: never a source)", async () => {
    await expect(
      dataviewsAdmin.create({ name: "Bad Source", sourceResourceId: functionResourceId, viewType: "TABLE" }),
    ).rejects.toMatchObject({ code: "DATAVIEW_SOURCE_TYPE_INVALID" } satisfies Partial<TotalBaseError>);
  });

  it("rejects a MISSING source", async () => {
    await expect(
      dataviewsAdmin.create({ name: "Missing Source", sourceResourceId: missingResourceId, viewType: "TABLE" }),
    ).rejects.toMatchObject({ code: "DATAVIEW_SOURCE_TYPE_INVALID" } satisfies Partial<TotalBaseError>);
  });

  it("creates an EXTERNALFRAME with no source and no fields, ignoring a source id", async () => {
    const dataview = await dataviewsAdmin.create({
      name: "Some Frame",
      sourceResourceId: tableResourceId,
      viewType: "EXTERNALFRAME",
      viewConfig: { frame_url: " https://reports.example.com/r/1 ", features: { fullscreen: false } },
    });
    expect(dataview.sourceResource).toBeNull();
    expect(dataview.viewConfig).toMatchObject({ frame_url: "https://reports.example.com/r/1", features: { fullscreen: false } });
    expect(await dataviewsAdmin.listFields(dataview.id)).toEqual([]);

    await expect(dataviewsAdmin.update(dataview.id, { viewConfig: { frame_url: "http://reports.example.com" } })).rejects.toMatchObject({
      code: "DATAVIEW_FRAME_URL_INVALID",
    } satisfies Partial<TotalBaseError>);
    await expect(dataviewsAdmin.update(dataview.id, { viewConfig: { frame_url: null } })).rejects.toMatchObject({
      code: "DATAVIEW_FRAME_URL_INVALID",
    } satisfies Partial<TotalBaseError>);
    // A patch that doesn't touch frame_url leaves it alone.
    const renamed = await dataviewsAdmin.update(dataview.id, { name: "Some Frame 2", viewConfig: { features: { fullscreen: true } } });
    expect(renamed.viewConfig).toMatchObject({ frame_url: "https://reports.example.com/r/1", features: { fullscreen: true } });

    // Publish + read back: the URL travels in view_config_snapshot.
    await dataviewsAdmin.publish(dataview.id, null);
    expect((await dataviewsAdmin.getPublished(dataview.id)).viewConfig).toMatchObject({ frame_url: "https://reports.example.com/r/1" });
  });

  it("rejects an EXTERNALFRAME without a valid https URL", async () => {
    for (const frameUrl of [undefined, "javascript:alert(1)", "http://example.com", "https://u:p@example.com"]) {
      await expect(
        dataviewsAdmin.create({ name: "Bad Frame", viewType: "EXTERNALFRAME", viewConfig: { frame_url: frameUrl } }),
      ).rejects.toMatchObject({ code: "DATAVIEW_FRAME_URL_INVALID" } satisfies Partial<TotalBaseError>);
    }
  });

  it("rejects an EXTERNALFRAME pointing at the instance's own origin", async () => {
    const withOrigin = new DataViewsAdminService(database, async () => "https://totalbase.example.com");
    await expect(
      withOrigin.create({ name: "Self Frame", viewType: "EXTERNALFRAME", viewConfig: { frame_url: "https://totalbase.example.com/admin/" } }),
    ).rejects.toMatchObject({ code: "DATAVIEW_FRAME_URL_INVALID" } satisfies Partial<TotalBaseError>);
  });

  it("the database CHECK keeps source_resource NULL exactly for EXTERNALFRAME", async () => {
    await expect(
      database.query(
        `INSERT INTO totalbase.dataviews (name, slug, source_resource, view_type) VALUES ('Chk A', 'chk-a', $1, 'EXTERNALFRAME')`,
        [tableResourceId],
      ),
    ).rejects.toMatchObject({ code: "CHECK_VIOLATION" });
    await expect(
      database.query(`INSERT INTO totalbase.dataviews (name, slug, source_resource, view_type) VALUES ('Chk B', 'chk-b', NULL, 'TABLE')`),
    ).rejects.toMatchObject({ code: "CHECK_VIOLATION" });
  });

  it("requires a source for every other layout", async () => {
    await expect(dataviewsAdmin.create({ name: "No Source", viewType: "TABLE" })).rejects.toMatchObject({
      code: "DATAVIEW_SOURCE_TYPE_INVALID",
    } satisfies Partial<TotalBaseError>);
  });

  it("accepts a MAP view type", async () => {
    const dataview = await dataviewsAdmin.create({ name: "Some Map", sourceResourceId: tableResourceId, viewType: "MAP" });
    expect(dataview.viewType).toBe("MAP");
  });

  // KANBAN's own `view_config.kanban_layout` (groupColumn/titleFormula/.../laneOrder) is just as
  // opaque to this service as MAP's `map_layout` already is - see this file's own top comment:
  // the server validates the type and the shape, apps/admin's types/dataview.ts owns what goes inside it.
  it("accepts a KANBAN view type", async () => {
    const dataview = await dataviewsAdmin.create({ name: "Some Kanban", sourceResourceId: tableResourceId, viewType: "KANBAN" });
    expect(dataview.viewType).toBe("KANBAN");
  });

  // Same reasoning as KANBAN just above - CALENDAR's own `view_config.calendar_layout`
  // (dateColumn/titleFormula/.../colorFormula) is just as opaque to this service.
  it("accepts a CALENDAR view type", async () => {
    const dataview = await dataviewsAdmin.create({ name: "Some Calendar", sourceResourceId: tableResourceId, viewType: "CALENDAR" });
    expect(dataview.viewType).toBe("CALENDAR");
  });

  // Same reasoning as KANBAN/CALENDAR just above - GANTT's own `view_config.gantt_layout`
  // (startDateColumn/endDateColumn/groupColumn/titleFormula/.../laneOrder) is just as opaque to
  // this service.
  it("accepts a GANTT view type", async () => {
    const dataview = await dataviewsAdmin.create({ name: "Some Gantt", sourceResourceId: tableResourceId, viewType: "GANTT" });
    expect(dataview.viewType).toBe("GANTT");
  });

  // TREE (Specification_DataViews.md §5.14): its parent is the table's foreign key to itself.
  it("accepts a TREE over a self-referencing table, fills its parent, and refuses one without it", async () => {
    await database.query(`DROP TABLE IF EXISTS public.dvpkg_tree_nodes`);
    await database.query(`CREATE TABLE public.dvpkg_tree_nodes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, parent uuid REFERENCES public.dvpkg_tree_nodes (id), position int, created timestamptz NOT NULL DEFAULT now(), due date DEFAULT CURRENT_DATE)`);
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status)
       VALUES ('public.dvpkg_tree_nodes'::regclass::oid, 'public', 'dvpkg_tree_nodes', 'TABLE', 'ACTIVE') RETURNING id`,
    );
    const treeResourceId = rows[0]!.id;
    try {
      const tree = await dataviewsAdmin.create({ name: "Some Tree", sourceResourceId: treeResourceId, viewType: "TREE", viewConfig: { tree_layout: { orderColumn: "position" } } });
      expect(tree.viewType).toBe("TREE");
      expect(tree.viewConfig.tree_layout).toMatchObject({ parentColumn: "parent", orderColumn: "position" });
      // Its record form shows what PostgreSQL fills - the key's gen_random_uuid(), the creation stamp's now() - only
      // once the record exists; a date defaulting to today is the viewer's to change (§6.2, §6.8).
      const { rows: formFields } = await database.query<{ column: string; visible: string | null }>(
        `SELECT config->'props'->>'column' AS column, config->'bindings'->'visible'->>'formula' AS visible
           FROM totalbase.dataviews_fields WHERE dataview = $1 AND widget = 'UFormField' ORDER BY 1`, [tree.id],
      );
      const notOnCreate = '{{vars.record.mode}} != "create"';
      expect(formFields).toEqual([
        { column: "created", visible: notOnCreate }, { column: "due", visible: null }, { column: "id", visible: notOnCreate },
        { column: "name", visible: null }, { column: "parent", visible: null }, { column: "position", visible: null },
      ]);
      // Not a foreign key to itself, an order that isn't a number.
      await expect(dataviewsAdmin.create({ name: "Bad Tree", sourceResourceId: treeResourceId, viewType: "TREE", viewConfig: { tree_layout: { parentColumn: "name" } } }))
        .rejects.toMatchObject({ code: "DATAVIEW_VIEW_CONFIG_INVALID" } satisfies Partial<TotalBaseError>);
      await expect(dataviewsAdmin.update(tree.id, { viewConfig: { tree_layout: { parentColumn: "parent", orderColumn: "name" } } }))
        .rejects.toMatchObject({ code: "DATAVIEW_VIEW_CONFIG_INVALID" } satisfies Partial<TotalBaseError>);
      // A table offering the tree as one of its views gets its parent too.
      const listed = await dataviewsAdmin.create({ name: "Tree Listed", sourceResourceId: treeResourceId, viewType: "TABLE", viewConfig: { layouts: ["TABLE", "TREE"] } });
      expect(listed.viewConfig.tree_layout).toMatchObject({ parentColumn: "parent" });
      // A table with no foreign key to itself has no tree.
      await expect(dataviewsAdmin.create({ name: "No Tree", sourceResourceId: tableResourceId, viewType: "TREE" }))
        .rejects.toMatchObject({ code: "DATAVIEW_VIEW_CONFIG_INVALID" } satisfies Partial<TotalBaseError>);
    } finally {
      await database.query(`DELETE FROM totalbase.dataviews WHERE source_resource = $1`, [treeResourceId]);
      await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [treeResourceId]);
      await database.query(`DROP TABLE IF EXISTS public.dvpkg_tree_nodes`);
    }
  });

  // Specification_DataViews.md §5.13: the main view is one of the views a list offers; never a change of kind.
  it("switches a list DataView's main view among the views it offers, and refuses any other change of type", async () => {
    const list = await dataviewsAdmin.create({ name: "Main View Switch", sourceResourceId: tableResourceId, viewType: "TABLE", viewConfig: { layouts: ["TABLE", "CARDS"] } });
    expect((await dataviewsAdmin.update(list.id, { viewType: "CARDS" })).viewType).toBe("CARDS");
    await expect(dataviewsAdmin.update(list.id, { viewType: "CALENDAR" })).rejects.toMatchObject({ code: "DATAVIEW_VIEW_CONFIG_INVALID" } satisfies Partial<TotalBaseError>);
    await expect(dataviewsAdmin.update(list.id, { viewType: "FORM" })).rejects.toMatchObject({ code: "DATAVIEW_VIEW_CONFIG_INVALID" } satisfies Partial<TotalBaseError>);
    // Offered and made the main view in one save.
    expect((await dataviewsAdmin.update(list.id, { viewType: "CALENDAR", viewConfig: { layouts: ["CALENDAR", "TABLE", "CARDS"] } })).viewType).toBe("CALENDAR");
  });

  // T61: a number column whose CHECK is a list (alicuota IN (0, 10.5, 21, 27)) is picked from it, like a text one.
  it("gives a numeric CHECK list a select in the generated form", async () => {
    await database.query(`DROP TABLE IF EXISTS public.dvpkg_iva`);
    await database.query(`CREATE TABLE public.dvpkg_iva (id serial PRIMARY KEY, nombre text, alicuota numeric(5,2) CHECK (alicuota IN (0, 10.5, 21, 27)))`);
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status)
       VALUES ('public.dvpkg_iva'::regclass::oid, 'public', 'dvpkg_iva', 'TABLE', 'ACTIVE') RETURNING id`,
    );
    try {
      const dataview = await dataviewsAdmin.create({ name: "Iva Form", sourceResourceId: rows[0]!.id, viewType: "TABLE" });
      const { rows: inputs } = await database.query<{ widget: string }>(
        `SELECT child.widget FROM totalbase.dataviews_fields child
         JOIN totalbase.dataviews_fields field ON field.id = child.parent AND field.widget = 'UFormField' AND field.config->'props'->>'column' = 'alicuota'
         WHERE child.dataview = $1`, [dataview.id],
      );
      expect(inputs.map((i) => i.widget)).toEqual(["USelect"]);
    } finally {
      await database.query(`DELETE FROM totalbase.dataviews WHERE source_resource = $1`, [rows[0]!.id]);
      await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [rows[0]!.id]);
      await database.query(`DROP TABLE IF EXISTS public.dvpkg_iva`);
    }
  });

  it("rejects a duplicate name and a duplicate slug", async () => {
    await dataviewsAdmin.create({ name: "Duplicate Me", sourceResourceId: tableResourceId, viewType: "TABLE" });
    await expect(
      dataviewsAdmin.create({ name: "Duplicate Me", sourceResourceId: tableResourceId, viewType: "TABLE" }),
    ).rejects.toMatchObject({ code: "DATAVIEW_NAME_DUPLICATE" } satisfies Partial<TotalBaseError>);
    await expect(
      dataviewsAdmin.create({ name: "Duplicate Me 2", slug: "duplicate-me", sourceResourceId: tableResourceId, viewType: "TABLE" }),
    ).rejects.toMatchObject({ code: "DATAVIEW_SLUG_DUPLICATE" } satisfies Partial<TotalBaseError>);
  });

  it("rejects an invalid color", async () => {
    await expect(
      dataviewsAdmin.create({ name: "Bad Color", sourceResourceId: tableResourceId, viewType: "TABLE", color: "not-a-color" }),
    ).rejects.toMatchObject({ code: "INVALID_DATAVIEW_COLOR" } satisfies Partial<TotalBaseError>);
  });

  it("get() 404s for an unknown id", async () => {
    await expect(dataviewsAdmin.get("00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({
      code: "DATAVIEW_NOT_FOUND",
    } satisfies Partial<TotalBaseError>);
  });

  it("update() patches identity fields without touching fields/source", async () => {
    const created = await dataviewsAdmin.create({ name: "Editable", sourceResourceId: tableResourceId, viewType: "TABLE" });
    const updated = await dataviewsAdmin.update(created.id, { description: "A test view", color: "blue" });
    expect(updated.description).toBe("A test view");
    expect(updated.color).toBe("blue");
    expect(updated.sourceResource).toBe(tableResourceId);
  });

  it("update() shallow-merges viewConfig instead of replacing it", async () => {
    const created = await dataviewsAdmin.create({
      name: "View Config Merge",
      sourceResourceId: tableResourceId,
      viewType: "TABLE",
      viewConfig: { features: { search: true, filter: false, columnsToggle: true, export: false, print: false } },
    });

    const updated = await dataviewsAdmin.update(created.id, { viewConfig: { edit_presentation: "MODAL" } });
    expect(updated.viewConfig).toEqual({
      variables: expect.any(Array),
      features: { search: true, filter: false, columnsToggle: true, export: false, print: false },
      edit_presentation: "MODAL",
      last_attnum: expect.any(Number),
    });

    // A second, unrelated merge doesn't disturb what the first one set.
    const updatedAgain = await dataviewsAdmin.update(created.id, { viewConfig: { edit_size: "md" } });
    expect(updatedAgain.viewConfig).toMatchObject({ edit_presentation: "MODAL", edit_size: "md" });
  });

  describe("view_config shapes (Specification_DataViews.md §2.7)", () => {
    let id: string;
    beforeAll(async () => {
      id = (await dataviewsAdmin.create({ name: "View Config Shapes", sourceResourceId: tableResourceId, viewType: "KANBAN", viewConfig: {} })).id;
    });

    it.each([
      ["an unknown key", { some_other_setting: true }],
      ["the server's last_attnum", { last_attnum: 99 }],
      ["a feature another type has", { features: { openInNewTab: true } }],
      ["a feature that isn't a boolean", { features: { search: "yes" } }],
      ["an unknown edit_presentation", { edit_presentation: "POPUP" }],
      ["an unknown page width", { page_content_width: "huge" }],
      ["fit_to_screen as text", { fit_to_screen: "true" }],
      ["an unknown layout key", { kanban_layout: { groupColumn: "brand", lanes: [] } }],
      ["a layout value of the wrong type", { kanban_layout: { laneOrder: "a,b" } }],
      ["a calendar weekStartsOn out of range", { calendar_layout: { weekStartsOn: 7 } }],
      ["a gantt zoom it doesn't have", { gantt_layout: { defaultZoom: "year" } }],
      ["a map view that isn't numbers", { map_view: { centerLat: "20", centerLng: 0, zoom: 2 } }],
      ["a layout that isn't an object", { card_layout: "{{title}}" }],
      ["a card image shape it doesn't have", { card_layout: { imageAspect: "2:1" } }],
      ["a base_where outside the filter grammar", { base_where: { title: { _nope: "x" } } }],
    ])("rejects %s with 422 DATAVIEW_VIEW_CONFIG_INVALID", async (_label, viewConfig) => {
      await expect(dataviewsAdmin.update(id, { viewConfig })).rejects.toMatchObject({ code: "DATAVIEW_VIEW_CONFIG_INVALID", httpStatus: 422 });
    });

    it("accepts what the wizard and the settings page send", async () => {
      await dataviewsAdmin.update(id, {
        viewConfig: {
          features: { search: false, savedViews: true, history: true, filter: true, import: false, export: true, refresh: true, recordClone: true, recordSaveAndNew: true, recordCopy: true, recordPrint: true, recordHistory: true, recordNavigation: true },
          edit_presentation: "PAGE", edit_size: "xl", edit_side: "left", column_sync: "locked", auto_refresh: null,
          page_content_width: "wide", page_content_align: "left", fit_to_screen: true, base_where: {}, default_state: { density: "compact", pageSize: 50 },
          kanban_layout: { groupColumn: null, titleFormula: "{{title}}", descriptionFormula: null, imageFormula: null, laneOrder: ["1", "2"], laneOrderColumn: null, laneColorColumn: null },
          card_layout: { imageFormula: "{{title}}", titleFormula: "{{title}}", descriptionFormula: null, imageAspect: "3:4", imageFit: "cover", imagePosition: "top" },
          map_layout: { pointColumn: null, latitudeColumn: null, longitudeColumn: null, nameFormula: null, descriptionFormula: null, iconFormula: null, colorFormula: null, defaultIcon: "i-lucide-map-pin", defaultColor: null },
          map_view: { centerLat: 20, centerLng: -190.5, zoom: 2 },
          calendar_layout: { dateColumn: null, titleFormula: null, descriptionFormula: null, colorFormula: null, defaultColor: "blue", weekStartsOn: 1, defaultView: "agenda" },
          gantt_layout: { startDateColumn: null, endDateColumn: null, groupColumn: null, titleFormula: null, descriptionFormula: null, colorFormula: null, defaultColor: "blue", laneOrder: [], defaultZoom: "week", laneColorColumn: null, laneOrderColumn: null, progressColumn: null },
        },
      });
    });

    it("warns, never refuses, publishing a single-record FORM over a table with more than one row", async () => {
      const single = await dataviewsAdmin.create({ name: "Single Record Form", sourceResourceId: tableResourceId, viewType: "FORM", viewConfig: { form_view_mode: "SINGLE" } });
      const { rows } = await database.query<{ id: string }>(
        `INSERT INTO public.${TABLE} (title, price) VALUES ('single a', 1), ('single b', 2) RETURNING id`,
      );
      try {
        const { rows: count } = await database.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${TABLE}`);
        expect(await dataviewsAdmin.publishWarnings(single.id)).toHaveLength(count[0]!.n > 1 ? 1 : 0);
        await database.query(`DELETE FROM public.${TABLE} WHERE id = ANY($1::uuid[])`, [rows.map((r) => r.id)]);
        const { rows: left } = await database.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${TABLE}`);
        expect(await dataviewsAdmin.publishWarnings(single.id)).toHaveLength(left[0]!.n > 1 ? 1 : 0);
        await dataviewsAdmin.update(single.id, { viewConfig: { form_view_mode: "UPDATE" } });
        expect(await dataviewsAdmin.publishWarnings(single.id)).toEqual([]);
      } finally {
        await database.query(`DELETE FROM public.${TABLE} WHERE id = ANY($1::uuid[])`, [rows.map((r) => r.id)]);
        await dataviewsAdmin.delete(single.id);
      }
    });

    it("checks a create's whole view_config too", async () => {
      await expect(dataviewsAdmin.create({ name: "View Config Bad Create", sourceResourceId: tableResourceId, viewType: "TABLE", viewConfig: { features: { openInNewTab: true } } }))
        .rejects.toMatchObject({ code: "DATAVIEW_VIEW_CONFIG_INVALID" });
    });
  });

  it("create() lays visible fields out one-up in a Sidebar (the default); in a Drawer two-up past 8 visible columns, one-up at or below it", async () => {
    const WIDE_TABLE = "dataviews_admin_pkg_test_wide";
    await database.query(`DROP TABLE IF EXISTS public.${WIDE_TABLE} CASCADE`);
    await database.query(`
      CREATE TABLE public.${WIDE_TABLE} (
        c1 int, c2 int, c3 int, c4 int, c5 int, c6 int, c7 int, c8 int, c9 int, c10 int
      )
    `);
    const { rows } = await database.query<{ oid: number }>(`SELECT $1::regclass::oid::int AS oid`, [`public.${WIDE_TABLE}`]);
    const { rows: resourceRows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status)
       VALUES ($1, 'public', $2, 'TABLE', 'ACTIVE') RETURNING id`,
      [rows[0]!.oid, WIDE_TABLE],
    );
    const wideResourceId = resourceRows[0]!.id;

    try {
      // The default record form, a Sidebar: one column however many fields (Specification_DataViews.md §6.3).
      const sidebar = await dataviewsAdmin.create({ name: "Sidebar Layout", sourceResourceId: wideResourceId, viewType: "TABLE" });
      const sidebarFields = (await dataviewsAdmin.listFields(sidebar.id)).filter((f) => f.kind === "COLUMN");
      expect(sidebarFields).toHaveLength(10);
      expect(sidebarFields.every((f) => f.gridW === 12 && f.gridX === 0)).toBe(true);
      await database.query(`DELETE FROM totalbase.dataviews WHERE id = $1`, [sidebar.id]);

      // A Drawer, all 10 columns visible (> 8) - two-up.
      const wide = await dataviewsAdmin.create({ name: "Wide Layout", sourceResourceId: wideResourceId, viewType: "TABLE", viewConfig: { edit_presentation: "DRAWER" } });
      const wideFields = (await dataviewsAdmin.listFields(wide.id)).filter((f) => f.kind === "COLUMN").sort((a, b) => a.gridY - b.gridY || a.gridX - b.gridX);
      expect(wideFields.map((f) => ({ x: f.gridX, y: f.gridY, w: f.gridW }))).toEqual([
        { x: 0, y: 0, w: 6 }, { x: 6, y: 0, w: 6 },
        { x: 0, y: 1, w: 6 }, { x: 6, y: 1, w: 6 },
        { x: 0, y: 2, w: 6 }, { x: 6, y: 2, w: 6 },
        { x: 0, y: 3, w: 6 }, { x: 6, y: 3, w: 6 },
        { x: 0, y: 4, w: 6 }, { x: 6, y: 4, w: 6 },
      ]);
      await database.query(`DELETE FROM totalbase.dataviews WHERE id = $1`, [wide.id]);

      // A Drawer with only 8 of the 10 columns visible (at the threshold, not past it) - one-up.
      const narrow = await dataviewsAdmin.create({
        name: "Narrow Layout",
        sourceResourceId: wideResourceId,
        viewType: "TABLE",
        viewConfig: { edit_presentation: "DRAWER" },
        selectedColumns: ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"],
      });
      const narrowFields = (await dataviewsAdmin.listFields(narrow.id))
        .filter((f) => f.kind === "COLUMN" && f.visible)
        .sort((a, b) => a.gridY - b.gridY);
      expect(narrowFields.every((f) => f.gridW === 12 && f.gridX === 0)).toBe(true);
      expect(narrowFields.map((f) => f.gridY)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      await database.query(`DELETE FROM totalbase.dataviews WHERE id = $1`, [narrow.id]);
    } finally {
      await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [wideResourceId]);
      await database.query(`DROP TABLE IF EXISTS public.${WIDE_TABLE} CASCADE`);
    }
  });

  it("syncFields() reconciles new, renamed, and dropped columns against dataviews_fields (schema drift)", async () => {
    const DRIFT_TABLE = "dataviews_admin_pkg_test_drift";
    await database.query(`DROP TABLE IF EXISTS public.${DRIFT_TABLE} CASCADE`);
    await database.query(`
      CREATE TABLE public.${DRIFT_TABLE} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        keep_me text,
        old_name text,
        going_away text
      )
    `);
    const { rows } = await database.query<{ oid: number }>(`SELECT $1::regclass::oid::int AS oid`, [`public.${DRIFT_TABLE}`]);
    const { rows: resourceRows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status)
       VALUES ($1, 'public', $2, 'TABLE', 'ACTIVE') RETURNING id`,
      [rows[0]!.oid, DRIFT_TABLE],
    );
    const driftResourceId = resourceRows[0]!.id;

    try {
      const dataview = await dataviewsAdmin.create({ name: "Drift Test", sourceResourceId: driftResourceId, viewType: "TABLE" });

      // Nothing drifted yet - a no-op.
      const noop = await dataviewsAdmin.syncFields(dataview.id);
      expect(noop).toEqual({ added: [], renamed: [], orphaned: [] });

      // Drift: a brand new column, an existing one renamed (same
      // attnum, real ALTER TABLE ... RENAME COLUMN - not a drop+add),
      // and an existing one dropped outright.
      await database.query(`ALTER TABLE public.${DRIFT_TABLE} ADD COLUMN brand_new text`);
      await database.query(`ALTER TABLE public.${DRIFT_TABLE} RENAME COLUMN old_name TO new_name`);
      await database.query(`ALTER TABLE public.${DRIFT_TABLE} DROP COLUMN going_away`);

      const result = await dataviewsAdmin.syncFields(dataview.id);

      expect(result.added).toHaveLength(1);
      expect(result.added[0]).toMatchObject({ kind: "COLUMN", columnName: "brand_new", visible: false });

      expect(result.renamed).toEqual([expect.objectContaining({ from: "old_name", to: "new_name" })]);

      expect(result.orphaned).toHaveLength(1);
      expect(result.orphaned[0]).toMatchObject({ kind: "COLUMN", columnName: "going_away" });

      // Applied for real, not just reported - a fresh listFields() reflects it.
      const fields = await dataviewsAdmin.listFields(dataview.id);
      expect(fields.some((f) => f.columnName === "brand_new" && !f.visible)).toBe(true);
      expect(fields.some((f) => f.columnName === "new_name")).toBe(true);
      expect(fields.some((f) => f.columnName === "old_name")).toBe(false);
      // The orphaned row is NOT deleted automatically - still there, unchanged.
      expect(fields.some((f) => f.columnName === "going_away")).toBe(true);

      // Idempotent - running it again finds nothing new to reconcile
      // (the orphaned row stays orphaned forever until someone deletes
      // it by hand - by design, see syncFields()'s own doc comment).
      const again = await dataviewsAdmin.syncFields(dataview.id);
      expect(again.added).toEqual([]);
      expect(again.renamed).toEqual([]);
      expect(again.orphaned).toHaveLength(1);

      await database.query(`DELETE FROM totalbase.dataviews WHERE id = $1`, [dataview.id]);
    } finally {
      await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [driftResourceId]);
      await database.query(`DROP TABLE IF EXISTS public.${DRIFT_TABLE} CASCADE`);
    }
  });

  it("a DataView reads only its columns: the wizard leaves unselected ones out, Add columns brings one in, Sync never brings a removed one back", async () => {
    const COLS_TABLE = "dataviews_admin_pkg_test_columns_in";
    await database.query(`DROP TABLE IF EXISTS public.${COLS_TABLE} CASCADE`);
    await database.query(`CREATE TABLE public.${COLS_TABLE} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, email text, phone text)`);
    const { rows } = await database.query<{ oid: number }>(`SELECT $1::regclass::oid::int AS oid`, [`public.${COLS_TABLE}`]);
    const { rows: resourceRows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status)
       VALUES ($1, 'public', $2, 'TABLE', 'ACTIVE') RETURNING id`,
      [rows[0]!.oid, COLS_TABLE],
    );
    const resourceId = resourceRows[0]!.id;
    const columnsOf = async (id: string) => (await dataviewsAdmin.listFields(id)).filter((f) => f.kind === "COLUMN").map((f) => f.columnName).sort();

    try {
      // The wizard's unselected column is out - no hidden field for it - but the primary key is always in, hidden when unselected.
      const dataview = await dataviewsAdmin.create({ name: "Columns In", sourceResourceId: resourceId, viewType: "TABLE", selectedColumns: ["name", "email"] });
      expect(await columnsOf(dataview.id)).toEqual(["email", "id", "name"]);
      expect((await dataviewsAdmin.listFields(dataview.id)).find((f) => f.columnName === "id")?.visible).toBe(false);

      // Add columns: a column not in it yet comes in shown; one already in it, or not in the table, is refused.
      const [phone] = await dataviewsAdmin.addColumns(dataview.id, ["phone"]);
      expect(phone).toMatchObject({ kind: "COLUMN", columnName: "phone", visible: true });
      await expect(dataviewsAdmin.addColumns(dataview.id, ["phone"])).rejects.toMatchObject({ code: "DATAVIEW_FIELD_DUPLICATE" });
      await expect(dataviewsAdmin.addColumns(dataview.id, ["nope"])).rejects.toMatchObject({ code: "DATAVIEW_COLUMN_INVALID" });

      // Removed, it stays out: Sync columns only adds what the table got after.
      await dataviewsAdmin.deleteField(dataview.id, phone!.id);
      await database.query(`ALTER TABLE public.${COLS_TABLE} ADD COLUMN created_later text`);
      const synced = await dataviewsAdmin.syncFields(dataview.id);
      expect(synced.added.map((f) => f.columnName)).toEqual(["created_later"]);
      expect(await columnsOf(dataview.id)).toEqual(["created_later", "email", "id", "name"]);
      expect((await dataviewsAdmin.syncFields(dataview.id)).added).toEqual([]);

      await database.query(`DELETE FROM totalbase.dataviews WHERE id = $1`, [dataview.id]);
    } finally {
      await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [resourceId]);
      await database.query(`DROP TABLE IF EXISTS public.${COLS_TABLE} CASCADE`);
    }
  });

  it("a related column (fk.column) comes in read through its foreign key, follows renames by attnum and is removed like a column", async () => {
    const BRANDS = "dataviews_admin_pkg_test_rel_brands";
    const HIDDEN = "dataviews_admin_pkg_test_rel_hidden";
    const PRODUCTS = "dataviews_admin_pkg_test_rel_products";
    for (const t of [PRODUCTS, BRANDS, HIDDEN]) await database.query(`DROP TABLE IF EXISTS public.${t} CASCADE`);
    await database.query(`CREATE TABLE public.${BRANDS} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, country text)`);
    await database.query(`CREATE TABLE public.${HIDDEN} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), secret text)`);
    await database.query(`CREATE TABLE public.${PRODUCTS} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text,
      brand uuid REFERENCES public.${BRANDS}(id), other uuid REFERENCES public.${HIDDEN}(id))`);
    const resources: string[] = [];
    const register = async (table: string, exposed: string[]) => {
      const { rows } = await database.query<{ id: string }>(
        `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
         VALUES ($1::regclass::oid::int, 'public', $2, 'TABLE', 'ACTIVE', $3) RETURNING id`,
        [`public.${table}`, table, exposed],
      );
      resources.push(rows[0]!.id);
      return rows[0]!.id;
    };
    await register(BRANDS, ["GET"]);
    await register(HIDDEN, []);
    const productsId = await register(PRODUCTS, ["GET"]);

    try {
      const dataview = await dataviewsAdmin.create({ name: "Related Columns", sourceResourceId: productsId, viewType: "TABLE", selectedColumns: ["title", "brand"] });

      // brand.country: a RELATED field, shown, titled by its target column (no title of its own), its identity the two attnums.
      const [country] = await dataviewsAdmin.addColumns(dataview.id, ["brand.country"]);
      expect(country).toMatchObject({ kind: "RELATED", columnName: "brand.country", label: null, visible: true, columnAttnum: null });
      expect(country!.relationAttnum).toEqual(expect.any(Number));
      expect(country!.targetAttnum).toEqual(expect.any(Number));
      // After every column already there - a column with no stored place doesn't jump to the front.
      const others = (await dataviewsAdmin.listFields(dataview.id)).filter((f) => f.id !== country!.id && f.kind !== "WIDGET");
      expect(country!.gridY).toBeGreaterThan(Math.max(...others.map((f) => f.gridY)));

      // Refused: twice, a column that isn't there, a key that isn't one, a table the Data API doesn't expose.
      await expect(dataviewsAdmin.addColumns(dataview.id, ["brand.country"])).rejects.toMatchObject({ code: "DATAVIEW_FIELD_DUPLICATE" });
      await expect(dataviewsAdmin.addColumns(dataview.id, ["brand.nope"])).rejects.toMatchObject({ code: "DATAVIEW_COLUMN_INVALID" });
      await expect(dataviewsAdmin.addColumns(dataview.id, ["title.name"])).rejects.toMatchObject({ code: "DATAVIEW_COLUMN_INVALID" });
      await expect(dataviewsAdmin.addColumns(dataview.id, ["other.secret"])).rejects.toMatchObject({ code: "DATAVIEW_COLUMN_INVALID" });

      // A rename of either end keeps it - Sync columns refreshes the path.
      await database.query(`ALTER TABLE public.${BRANDS} RENAME COLUMN country TO origin`);
      await database.query(`ALTER TABLE public.${PRODUCTS} RENAME COLUMN brand TO maker`);
      const synced = await dataviewsAdmin.syncFields(dataview.id);
      expect(synced.renamed).toContainEqual({ fieldId: country!.id, from: "brand.country", to: "maker.origin" });
      expect((await dataviewsAdmin.listFields(dataview.id)).find((f) => f.id === country!.id)?.columnName).toBe("maker.origin");

      // Its target column dropped: orphaned, not deleted - then removed like a column.
      await database.query(`ALTER TABLE public.${BRANDS} DROP COLUMN origin`);
      expect((await dataviewsAdmin.syncFields(dataview.id)).orphaned.map((f) => f.id)).toEqual([country!.id]);
      await dataviewsAdmin.deleteField(dataview.id, country!.id);
      expect((await dataviewsAdmin.listFields(dataview.id)).some((f) => f.kind === "RELATED")).toBe(false);

      await database.query(`DELETE FROM totalbase.dataviews WHERE id = $1`, [dataview.id]);
    } finally {
      await database.query(`DELETE FROM totalbase.resources WHERE id = ANY($1::uuid[])`, [resources]);
      for (const t of [PRODUCTS, BRANDS, HIDDEN]) await database.query(`DROP TABLE IF EXISTS public.${t} CASCADE`);
    }
  });

  it("a DataView's column takes its title and presentation from its table's column - none of its own", async () => {
    const dataview = await dataviewsAdmin.create({ name: "No Own Presentation", sourceResourceId: tableResourceId, viewType: "TABLE" });
    try {
      const title = (await dataviewsAdmin.listFields(dataview.id)).find((f) => f.kind === "COLUMN" && f.columnName === "title")!;
      await expect(dataviewsAdmin.updateField(dataview.id, title.id, { label: "Título" })).rejects.toMatchObject({ code: "DATAVIEW_COLUMN_INVALID" });
      for (const own of [{ displayFormat: "#,##0" }, { bold: true }, { conditions: [] }, { disabledConditions: ["x"] }, { display_field: "name" }, { shortLabel: "T" }]) {
        await expect(dataviewsAdmin.updateField(dataview.id, title.id, { config: { ...title.config, ...own } })).rejects.toMatchObject({ code: "DATAVIEW_COLUMN_INVALID" });
      }
      // What the list does with it is its own; no title (null) is always fine.
      const saved = await dataviewsAdmin.updateField(dataview.id, title.id, { label: null, visible: false, config: { ...title.config, truncate: true, copyable: true, total: "count" } });
      expect(saved).toMatchObject({ label: null, visible: false, config: expect.objectContaining({ truncate: true, copyable: true, total: "count" }) });
    } finally {
      await database.query(`DELETE FROM totalbase.dataviews WHERE id = $1`, [dataview.id]);
    }
  });

  it("a foreign key shows what its table's row presentation says - live on the draft, frozen on publish", async () => {
    const BRANDS = "dataviews_admin_pkg_test_row_brands";
    const ITEMS = "dataviews_admin_pkg_test_row_items";
    for (const t of [ITEMS, BRANDS]) await database.query(`DROP TABLE IF EXISTS public.${t} CASCADE`);
    await database.query(`CREATE TABLE public.${BRANDS} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, code text)`);
    await database.query(`CREATE TABLE public.${ITEMS} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text, brand uuid REFERENCES public.${BRANDS}(id))`);
    const resources: string[] = [];
    for (const table of [BRANDS, ITEMS]) {
      const { rows } = await database.query<{ id: string }>(
        `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
         VALUES ($1::regclass::oid::int, 'public', $2, 'TABLE', 'ACTIVE', '{GET}') RETURNING id`,
        [`public.${table}`, table],
      );
      resources.push(rows[0]!.id);
    }
    const setRowPresentation = (value: object) =>
      database.query(`UPDATE totalbase.resources SET row_presentation = $2::jsonb WHERE id = $1`, [resources[0], JSON.stringify(value)]);
    let dataviewId: string | undefined;
    try {
      const dataview = await dataviewsAdmin.create({ name: "Row Presentation", sourceResourceId: resources[1]!, viewType: "TABLE" });
      dataviewId = dataview.id;
      const brand = async (published = false) => (await (published ? dataviewsAdmin.listPublishedFields(dataview.id) : dataviewsAdmin.listFields(dataview.id)))
        .find((f) => f.kind === "COLUMN" && f.columnName === "brand")!;
      const stored = async () => (await database.query<{ config: Record<string, unknown> }>(
        `SELECT config FROM totalbase.dataviews_fields WHERE dataview = $1 AND column_name = 'brand'`, [dataview.id])).rows[0]!.config;

      // Nothing set anywhere: the default column, inherited - none of it stored.
      expect((await brand()).config).toMatchObject({ display_field: "name", display_inherited: true });
      expect(await stored()).not.toHaveProperty("display_field");

      // The table says: every column pointing at it follows, at once on the draft.
      await setRowPresentation({ displayTemplate: "{{code}} - {{name}}" });
      expect((await brand()).config).toMatchObject({ display_field: "code", display_template: "{{code}} - {{name}}", display_inherited: true });

      // Sent back as read (another option changed): still inherited, nothing stored.
      await dataviewsAdmin.updateField(dataview.id, (await brand()).id, { config: { ...(await brand()).config, truncate: true } });
      expect(await stored()).toEqual({ truncate: true });

      // Published: frozen. The table changes; the draft follows and differs, the published version doesn't.
      await dataviewsAdmin.publish(dataview.id, null);
      await setRowPresentation({ displayField: "name" });
      expect((await brand()).config).toMatchObject({ display_field: "name", display_inherited: true });
      expect((await brand(true)).config).toMatchObject({ display_field: "code", display_template: "{{code}} - {{name}}" });
      expect(await dataviewsAdmin.hasUnpublishedChanges(dataview.id)).toBe(true);
      expect((await dataviewsAdmin.affectedByColumnPresentation(resources[0]!)).map((d) => d.id)).toContain(dataview.id);

      // None of its own: what it shows is the table's (Specification_DataViews.md §15.5).
      const { display_inherited: _flag, display_template: _template, ...own } = (await brand()).config as Record<string, unknown>;
      await expect(dataviewsAdmin.updateField(dataview.id, (await brand()).id, { config: { ...own, display_field: "code" } })).rejects.toMatchObject({ code: "DATAVIEW_COLUMN_INVALID" });
    } finally {
      if (dataviewId) await database.query(`DELETE FROM totalbase.dataviews WHERE id = $1`, [dataviewId]);
      await database.query(`DELETE FROM totalbase.resources WHERE id = ANY($1::uuid[])`, [resources]);
      for (const t of [ITEMS, BRANDS]) await database.query(`DROP TABLE IF EXISTS public.${t} CASCADE`);
    }
  });

  it("syncFields() respects view_config.column_sync - auto_show adds a new column visible, locked adds none at all", async () => {
    const SYNC_TABLE = "dataviews_admin_pkg_test_column_sync";
    await database.query(`DROP TABLE IF EXISTS public.${SYNC_TABLE} CASCADE`);
    await database.query(`CREATE TABLE public.${SYNC_TABLE} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), keep_me text)`);
    const { rows } = await database.query<{ oid: number }>(`SELECT $1::regclass::oid::int AS oid`, [`public.${SYNC_TABLE}`]);
    const { rows: resourceRows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status)
       VALUES ($1, 'public', $2, 'TABLE', 'ACTIVE') RETURNING id`,
      [rows[0]!.oid, SYNC_TABLE],
    );
    const syncResourceId = resourceRows[0]!.id;

    try {
      // auto_show - a newly-discovered column is added VISIBLE, not hidden.
      const showDataview = await dataviewsAdmin.create({
        name: "Column Sync Show",
        sourceResourceId: syncResourceId,
        viewType: "TABLE",
        viewConfig: { column_sync: "auto_show" },
      });
      await database.query(`ALTER TABLE public.${SYNC_TABLE} ADD COLUMN newly_added text`);
      const showResult = await dataviewsAdmin.syncFields(showDataview.id);
      expect(showResult.added).toHaveLength(1);
      expect(showResult.added[0]).toMatchObject({ columnName: "newly_added", visible: true });
      await database.query(`ALTER TABLE public.${SYNC_TABLE} DROP COLUMN newly_added`);
      await database.query(`DELETE FROM totalbase.dataviews WHERE id = $1`, [showDataview.id]);

      // locked - the column set is frozen; a real new column gets NO
      // field row at all, not even hidden.
      const lockedDataview = await dataviewsAdmin.create({
        name: "Column Sync Locked",
        sourceResourceId: syncResourceId,
        viewType: "TABLE",
        viewConfig: { column_sync: "locked" },
      });
      await database.query(`ALTER TABLE public.${SYNC_TABLE} ADD COLUMN never_synced text`);
      const lockedResult = await dataviewsAdmin.syncFields(lockedDataview.id);
      expect(lockedResult.added).toEqual([]);
      const lockedFields = await dataviewsAdmin.listFields(lockedDataview.id);
      expect(lockedFields.some((f) => f.columnName === "never_synced")).toBe(false);
      await database.query(`ALTER TABLE public.${SYNC_TABLE} DROP COLUMN never_synced`);
      await database.query(`DELETE FROM totalbase.dataviews WHERE id = $1`, [lockedDataview.id]);
    } finally {
      await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [syncResourceId]);
      await database.query(`DROP TABLE IF EXISTS public.${SYNC_TABLE} CASCADE`);
    }
  });

  it("updateField() edits position/size/visibility/widget/config for one COLUMN field", async () => {
    const dataview = await dataviewsAdmin.create({ name: "Field Update Target", sourceResourceId: tableResourceId, viewType: "TABLE" });
    const fields = await dataviewsAdmin.listFields(dataview.id);
    const priceField = fields.find((f) => f.columnName === "price")!;

    const updated = await dataviewsAdmin.updateField(dataview.id, priceField.id, {
      widget: "UInput",
      visible: false,
      config: { truncate: true },
      gridX: 6,
      gridY: 2,
      gridW: 6,
      gridH: 1,
    });
    expect(updated).toMatchObject({
      widget: "UInput",
      visible: false,
      config: { truncate: true },
      gridX: 6,
      gridY: 2,
      gridW: 6,
      gridH: 1,
    });

    // column_attnum/column_name/kind stay untouched - only configuration moved.
    expect(updated.columnName).toBe("price");
    expect(updated.kind).toBe("COLUMN");
  });

  it("updateField() accepts every column widget of the catalog, and no other widget", async () => {
    const dataview = await dataviewsAdmin.create({ name: "Field Update Widgets", sourceResourceId: tableResourceId, viewType: "TABLE" });
    const fields = await dataviewsAdmin.listFields(dataview.id);
    const priceField = fields.find((f) => f.columnName === "price")!;

    for (const widget of COLUMN_WIDGET_NAMES) {
      const updated = await dataviewsAdmin.updateField(dataview.id, priceField.id, { widget });
      expect(updated.widget).toBe(widget);
    }
    // A catalog widget that edits no column value, and a pre-catalog name.
    for (const widget of ["UButton", "UColorSelect"]) {
      await expect(dataviewsAdmin.updateField(dataview.id, priceField.id, { widget })).rejects.toMatchObject({ code: "DATAVIEW_FIELD_WIDGET_INVALID" });
    }
  });

  it("updateField() rejects an unknown widget and an unknown field id", async () => {
    const dataview = await dataviewsAdmin.create({ name: "Field Update Reject", sourceResourceId: tableResourceId, viewType: "TABLE" });
    const fields = await dataviewsAdmin.listFields(dataview.id);
    const anyField = fields.find((f) => f.kind === "COLUMN")!;

    await expect(
      dataviewsAdmin.updateField(dataview.id, anyField.id, { widget: "NotAWidget" }),
    ).rejects.toMatchObject({ code: "DATAVIEW_FIELD_WIDGET_INVALID" });

    await expect(
      dataviewsAdmin.updateField(dataview.id, "00000000-0000-0000-0000-000000000000", { visible: false }),
    ).rejects.toMatchObject({ code: "DATAVIEW_FIELD_NOT_FOUND" });
  });

  it("addWidget() starts a widget as the Design form does - the catalog's defaults under what was sent", async () => {
    const dataview = await dataviewsAdmin.create({ name: "Widget Defaults Target", sourceResourceId: tableResourceId, viewType: "TABLE" });
    const tabs = await dataviewsAdmin.addWidget(dataview.id, { widget: "UTabs" });
    expect((tabs.config as { props: Record<string, unknown> }).props.items).toEqual([{ label: "Tab 1", value: "tab1" }, { label: "Tab 2", value: "tab2" }]);
    const own = await dataviewsAdmin.addWidget(dataview.id, { widget: "UTabs", config: { props: { items: [{ label: "Uno", value: "uno" }], color: "neutral" } } });
    expect((own.config as { props: Record<string, unknown> }).props).toEqual({ items: [{ label: "Uno", value: "uno" }], color: "neutral" });
    await database.query(`DELETE FROM totalbase.dataviews WHERE id = $1`, [dataview.id]);
  });

  it("deleteField() removes a widget outright, and a COLUMN field leaves the DataView", async () => {
    const dataview = await dataviewsAdmin.create({ name: "Control Delete Target", sourceResourceId: tableResourceId, viewType: "TABLE" });
    const control = await dataviewsAdmin.addWidget(dataview.id, { widget: "UAlert", config: { props: { title: "Heads up" } } });

    await dataviewsAdmin.deleteField(dataview.id, control.id);
    const { rows } = await database.query(`SELECT 1 FROM totalbase.dataviews_fields WHERE id = $1`, [control.id]);
    expect(rows).toHaveLength(0);

    const columns = (await dataviewsAdmin.listFields(dataview.id)).filter((f) => f.kind === "COLUMN");
    const columnField = columns.find((f) => f.columnName === "title")!;
    await dataviewsAdmin.deleteField(dataview.id, columnField.id);
    expect((await dataviewsAdmin.listFields(dataview.id)).some((f) => f.id === columnField.id)).toBe(false);

    // Never the primary key: editing and deleting a row need it.
    const primaryKey = columns.find((f) => f.columnName === "id")!;
    await expect(dataviewsAdmin.deleteField(dataview.id, primaryKey.id)).rejects.toMatchObject({ code: "DATAVIEW_FIELD_NOT_DELETABLE" });

    await expect(
      dataviewsAdmin.deleteField(dataview.id, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toMatchObject({ code: "DATAVIEW_FIELD_NOT_FOUND" });
  });

  it("dataviewOfField() still finds a published field the draft already deleted", async () => {
    const dataview = await dataviewsAdmin.create({ name: "Field Owner Target", sourceResourceId: tableResourceId, viewType: "TABLE" });
    const control = await dataviewsAdmin.addWidget(dataview.id, { widget: "UAlert", config: { props: { title: "Published" } } });
    await dataviewsAdmin.publish(dataview.id, null);
    await dataviewsAdmin.deleteField(dataview.id, control.id);

    expect(await dataviewsAdmin.dataviewOfField(control.id)).toBe(dataview.id);
    expect((await dataviewsAdmin.listPublishedFields(dataview.id)).some((f) => f.id === control.id)).toBe(true);
    expect(await dataviewsAdmin.dataviewOfField("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("delete() removes the DataView and cascades its fields", async () => {
    const created = await dataviewsAdmin.create({ name: "Deletable", sourceResourceId: tableResourceId, viewType: "TABLE" });
    await dataviewsAdmin.delete(created.id);
    await expect(dataviewsAdmin.get(created.id)).rejects.toMatchObject({ code: "DATAVIEW_NOT_FOUND" } satisfies Partial<TotalBaseError>);
    const { rows } = await database.query(`SELECT 1 FROM totalbase.dataviews_fields WHERE dataview = $1`, [created.id]);
    expect(rows).toHaveLength(0);
  });

  it("create() and syncFields() seed a field's widget/config from resources_columns when the wizard already recorded one", async () => {
    const SEED_TABLE = "dataviews_admin_pkg_test_seeded";
    await database.query(`DROP TABLE IF EXISTS public.${SEED_TABLE} CASCADE`);
    await database.query(`CREATE TABLE public.${SEED_TABLE} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bio text, extra text)`);
    const { rows } = await database.query<{ oid: number }>(`SELECT $1::regclass::oid::int AS oid`, [`public.${SEED_TABLE}`]);
    const { rows: resourceRows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status)
       VALUES ($1, 'public', $2, 'TABLE', 'ACTIVE') RETURNING id`,
      [rows[0]!.oid, SEED_TABLE],
    );
    const seedResourceId = resourceRows[0]!.id;

    try {
      // The Add Column wizard's Push path already recorded 'bio' as
      // the `markdown` column type - a create() right after must read that, not
      // fall back to the catalog rule's plain Text (UInput).
      await pushColumnPresentation(database, { schema: "public", table: SEED_TABLE, columnName: "bio", config: { input: "markdown" } });

      const dataview = await dataviewsAdmin.create({ name: "Seeded", sourceResourceId: seedResourceId, viewType: "TABLE" });
      const fields = await dataviewsAdmin.listFields(dataview.id);
      const bioField = fields.find((f) => f.columnName === "bio");
      // `markdown` is the column type the wizard wrote - a DataView field's
      // widget is a catalog widget, where all three Rich text types
      // collapse into the one UEditor, `editorContentType` telling it which.
      expect(bioField?.widget).toBe("UEditor");
      expect(bioField?.config).toMatchObject({ editorContentType: "markdown" });
      // A column with no resources_columns row (never touched by Push)
      // still falls back to live inference exactly as before.
      expect(fields.find((f) => f.columnName === "extra")?.widget).toBe("UInput");

      // An explicit override to a DIFFERENT widget (the wizard's Columns
      // step) wins, and doesn't inherit the stored widget's own config -
      // `editorContentType` means nothing to a UTextarea.
      const overridden = await dataviewsAdmin.create({
        name: "Seeded Override",
        sourceResourceId: seedResourceId,
        viewType: "TABLE",
        fieldOverrides: { bio: { widget: "UTextarea" } },
      });
      const overriddenBio = (await dataviewsAdmin.listFields(overridden.id)).find((f) => f.columnName === "bio");
      expect(overriddenBio?.widget).toBe("UTextarea");
      expect(overriddenBio?.config).not.toHaveProperty("editorContentType");

      // syncFields() picks up the same seed for a column added later.
      await database.query(`ALTER TABLE public.${SEED_TABLE} ADD COLUMN notes text`);
      await pushColumnPresentation(database, { schema: "public", table: SEED_TABLE, columnName: "notes", config: { input: "long-text" } });
      const syncResult = await dataviewsAdmin.syncFields(dataview.id);
      expect(syncResult.added).toHaveLength(1);
      expect(syncResult.added[0]).toMatchObject({ columnName: "notes", widget: "UTextarea" });
    } finally {
      // Delete by source_resource, not a captured dataview.id - a failed
      // assertion above must not skip cleanup and leak a "Seeded" row
      // that then collides with the next run's own create() (unique name).
      await database.query(`DELETE FROM totalbase.dataviews WHERE source_resource = $1`, [seedResourceId]);
      await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [seedResourceId]);
      await database.query(`DROP TABLE IF EXISTS public.${SEED_TABLE} CASCADE`);
    }
  });

  it("ignores a resources_columns seed that is no longer valid for the column's current type", async () => {
    const STALE_TABLE = "dataviews_admin_pkg_test_stale_seed";
    await database.query(`DROP TABLE IF EXISTS public.${STALE_TABLE} CASCADE`);
    await database.query(`CREATE TABLE public.${STALE_TABLE} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), amount text)`);
    const { rows } = await database.query<{ oid: number }>(`SELECT $1::regclass::oid::int AS oid`, [`public.${STALE_TABLE}`]);
    const { rows: resourceRows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status)
       VALUES ($1, 'public', $2, 'TABLE', 'ACTIVE') RETURNING id`,
      [rows[0]!.oid, STALE_TABLE],
    );
    const staleResourceId = resourceRows[0]!.id;

    try {
      // Seeded while `amount` was still text (a valid UInput/UTextarea/
      // etc. choice), then the column's real type changed to numeric -
      // the stale seed ('UPinInput' isn't offered for a numeric column)
      // must be discarded in favor of fresh inference, not applied blindly.
      await pushColumnPresentation(database, { schema: "public", table: STALE_TABLE, columnName: "amount", config: { input: "pin" } });
      await database.query(`ALTER TABLE public.${STALE_TABLE} ALTER COLUMN amount TYPE numeric USING amount::numeric`);

      const dataview = await dataviewsAdmin.create({ name: "Stale Seed", sourceResourceId: staleResourceId, viewType: "TABLE" });
      const fields = await dataviewsAdmin.listFields(dataview.id);
      expect(fields.find((f) => f.columnName === "amount")?.widget).toBe("UInput");
    } finally {
      await database.query(`DELETE FROM totalbase.dataviews WHERE source_resource = $1`, [staleResourceId]);
      await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [staleResourceId]);
      await database.query(`DROP TABLE IF EXISTS public.${STALE_TABLE} CASCADE`);
    }
  });

  it("list() returns every DataView, ordered by name; the App's listPublished() only LISTED ones", async () => {
    const dataview = await dataviewsAdmin.create({ name: "Scope Embedded", sourceResourceId: tableResourceId, viewType: "TABLE" });
    await dataviewsAdmin.publish(dataview.id, null);
    expect((await dataviewsAdmin.listPublished()).some((d) => d.id === dataview.id)).toBe(true);

    // The "Show in the App menu" switch, off.
    expect((await dataviewsAdmin.update(dataview.id, { scope: "EMBEDDED_ONLY" })).scope).toBe("EMBEDDED_ONLY");
    const list = await dataviewsAdmin.list();
    expect(list.find((d) => d.id === dataview.id)?.scope).toBe("EMBEDDED_ONLY");
    const names = list.map((d) => d.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect((await dataviewsAdmin.listPublished()).some((d) => d.id === dataview.id)).toBe(false);
    // Still openable (by embedding hosts, or a direct link for anyone granted).
    expect((await dataviewsAdmin.getPublished(dataview.id)).id).toBe(dataview.id);

    await expect(dataviewsAdmin.update(dataview.id, { scope: "HIDDEN" as never })).rejects.toMatchObject({ code: "CHECK_VIOLATION" });
  });

  // Specification.md §13 - draft vs immutable versions, Restore, Save as.
  describe("versioning", () => {
    it("creates a draft only - nothing is published implicitly", async () => {
      const dataview = await dataviewsAdmin.create({ name: "Versioning Draft", sourceResourceId: tableResourceId, viewType: "TABLE" });
      expect(await dataviewsAdmin.listVersions(dataview.id)).toEqual([]);
      const status = await dataviewsAdmin.getWithStatus(dataview.id);
      expect(status.liveVersion).toBeNull();
      expect(status.hasUnpublishedChanges).toBe(true);
      await expect(dataviewsAdmin.getPublished(dataview.id)).rejects.toSatisfy(
        (error: unknown) => error instanceof TotalBaseError && error.code === "DATAVIEW_NOT_FOUND",
      );
      expect((await dataviewsAdmin.listPublished()).some((d) => d.id === dataview.id)).toBe(false);
    });

    it("publishes, restores an older version into the draft only, and reports changes", async () => {
      const dataview = await dataviewsAdmin.create({ name: "Versioning Restore", sourceResourceId: tableResourceId, viewType: "TABLE" });
      const card = await dataviewsAdmin.addWidget(dataview.id, { widget: "UCard" });
      const inCard = await dataviewsAdmin.addWidget(dataview.id, { widget: "UBadge", parent: card.id, config: { slot: "default" } });
      const title = (await dataviewsAdmin.listFields(dataview.id)).find((f) => f.columnName === "title")!;
      await dataviewsAdmin.updateField(dataview.id, title.id, { gridW: 4 });

      const v1 = await dataviewsAdmin.publish(dataview.id, null);
      expect(v1.version).toBe(1);
      expect((await dataviewsAdmin.getWithStatus(dataview.id)).hasUnpublishedChanges).toBe(false);
      expect((await dataviewsAdmin.publish(dataview.id, null)).version).toBe(1); // no-op

      await dataviewsAdmin.updateField(dataview.id, title.id, { gridW: 8 });
      await dataviewsAdmin.updateCode(dataview.id, "// v2");
      expect((await dataviewsAdmin.getWithStatus(dataview.id)).hasUnpublishedChanges).toBe(true);
      expect((await dataviewsAdmin.publish(dataview.id, null)).version).toBe(2);

      const preview = await dataviewsAdmin.getVersion(dataview.id, 1);
      expect(preview.dataview.code).toBe("");
      expect(preview.fields.find((f) => f.id === title.id)?.gridW).toBe(4);

      await dataviewsAdmin.restore(dataview.id, 1);
      const draftTitle = (await dataviewsAdmin.listFields(dataview.id)).find((f) => f.id === title.id)!;
      expect(draftTitle.gridW).toBe(4);
      expect((await dataviewsAdmin.listFields(dataview.id)).find((f) => f.id === inCard.id)?.parent).toBe(card.id);
      // Nothing went live - viewers still get v2 until an explicit Publish.
      let status = await dataviewsAdmin.getWithStatus(dataview.id);
      expect(status.liveVersion).toBe(2);
      expect(status.hasUnpublishedChanges).toBe(true);
      expect((await dataviewsAdmin.listPublishedFields(dataview.id)).find((f) => f.id === title.id)?.gridW).toBe(8);

      // Publishing the untouched restore records where it came from (the
      // re-inserted rows' fresh timestamps don't count as a change).
      const v3 = await dataviewsAdmin.publish(dataview.id, null);
      expect(v3.version).toBe(3);
      expect(v3.restoredFromVersion).toBe(1);
      status = await dataviewsAdmin.getWithStatus(dataview.id);
      expect(status.hasUnpublishedChanges).toBe(false);
      expect(status.liveVersion).toBe(3);
      expect((await dataviewsAdmin.listPublishedFields(dataview.id)).find((f) => f.id === title.id)?.gridW).toBe(4);

      // Restored, then edited: an ordinary version, not "restored from".
      await dataviewsAdmin.restore(dataview.id, 2);
      await dataviewsAdmin.updateCode(dataview.id, "// v2 edited");
      expect((await dataviewsAdmin.publish(dataview.id, null)).restoredFromVersion).toBeNull();
    });

    // Specification_DataViews.md §15: a draft inherits live, a version keeps what it inherited.
    it("freezes what it inherits from its resource's columns at Publish", async () => {
      const dataview = await dataviewsAdmin.create({ name: "Versioning Presentation", sourceResourceId: tableResourceId, viewType: "TABLE" });
      const setLabel = (label: string) => database.query(
        `INSERT INTO totalbase.resources_columns (resource, attnum, name, config)
         SELECT $1, attnum, attname, jsonb_build_object('label', $2::text)
         FROM pg_attribute WHERE attrelid = $3::regclass AND attname = 'title'
         ON CONFLICT (resource, attnum) DO UPDATE SET config = EXCLUDED.config`,
        [tableResourceId, label, `public.${TABLE}`],
      );
      const titleOf = (view: { columnPresentation?: Record<string, Record<string, { label?: string }>> }) => view.columnPresentation?.[tableResourceId]?.title?.label;
      try {
        await setLabel("Título");
        await dataviewsAdmin.publish(dataview.id, null);
        expect((await dataviewsAdmin.getWithStatus(dataview.id)).hasUnpublishedChanges).toBe(false);
        expect(titleOf(await dataviewsAdmin.getPublished(dataview.id))).toBe("Título");

        await setLabel("Nombre");
        // The draft reads it live; viewers keep the published one until it's published again.
        expect(titleOf(await dataviewsAdmin.get(dataview.id))).toBe("Nombre");
        expect(titleOf(await dataviewsAdmin.getPublished(dataview.id))).toBe("Título");
        expect((await dataviewsAdmin.getWithStatus(dataview.id)).hasUnpublishedChanges).toBe(true);
        expect((await dataviewsAdmin.list()).find((d) => d.id === dataview.id)?.hasUnpublishedChanges).toBe(true);

        // The change lists it, with nothing else unpublished - it may be published right away.
        const affected = async () => (await dataviewsAdmin.affectedByColumnPresentation(tableResourceId)).find((d) => d.id === dataview.id);
        expect(await affected()).toMatchObject({ liveVersion: 1, otherChanges: false });

        // Each column field carries what it inherits - the draft's live, the published one's frozen.
        const titleField = async (fields: Promise<{ columnName: string | null; inherited?: { label?: string } }[]>) => (await fields).find((f) => f.columnName === "title")?.inherited?.label;
        expect(await titleField(dataviewsAdmin.listFields(dataview.id))).toBe("Nombre");
        expect(await titleField(dataviewsAdmin.listPublishedFields(dataview.id))).toBe("Título");

        expect((await dataviewsAdmin.publish(dataview.id, null)).version).toBe(2);
        expect(titleOf(await dataviewsAdmin.getPublished(dataview.id))).toBe("Nombre");
        expect(await titleField(dataviewsAdmin.listPublishedFields(dataview.id))).toBe("Nombre");
        expect(await affected()).toBeUndefined();

        // With another unpublished change too, publishing it would take that along - the list says so.
        await dataviewsAdmin.updateCode(dataview.id, "// edited");
        await setLabel("Denominación");
        expect(await affected()).toMatchObject({ liveVersion: 2, otherChanges: true });
        expect(titleOf((await dataviewsAdmin.getVersion(dataview.id, 1)).dataview)).toBe("Título");
      } finally {
        await database.query(`DELETE FROM totalbase.resources_columns WHERE resource = $1`, [tableResourceId]);
      }
    });

    it("list() reports each DataView's status, the same as the editor header", async () => {
      const dataview = await dataviewsAdmin.create({ name: "Versioning Status", sourceResourceId: tableResourceId, viewType: "TABLE" });
      const title = (await dataviewsAdmin.listFields(dataview.id)).find((f) => f.columnName === "title")!;
      await dataviewsAdmin.updateField(dataview.id, title.id, { gridW: 6, config: { required: true, truncate: true } });
      await dataviewsAdmin.updateCode(dataview.id, "// code");
      const statusInList = async () => {
        const row = (await dataviewsAdmin.list()).find((d) => d.id === dataview.id)!;
        expect(row.hasUnpublishedChanges).toBe(await dataviewsAdmin.hasUnpublishedChanges(dataview.id));
        return { live: row.liveVersion, changed: row.hasUnpublishedChanges };
      };

      expect(await statusInList()).toEqual({ live: null, changed: true });
      await dataviewsAdmin.publish(dataview.id, null);
      expect(await statusInList()).toEqual({ live: 1, changed: false });
      await dataviewsAdmin.updateField(dataview.id, title.id, { gridW: 5 });
      expect(await statusInList()).toEqual({ live: 1, changed: true });
      await dataviewsAdmin.restore(dataview.id, 1);
      expect(await statusInList()).toEqual({ live: 1, changed: false });
    });

    it("Save as creates an unpublished copy with fresh ids and remapped widget parents", async () => {
      const dataview = await dataviewsAdmin.create({ name: "Versioning Source", sourceResourceId: tableResourceId, viewType: "TABLE" });
      const card = await dataviewsAdmin.addWidget(dataview.id, { widget: "UCard", label: "card" });
      await dataviewsAdmin.addWidget(dataview.id, { widget: "UBadge", label: "inCard", parent: card.id, config: { slot: "default" } });
      const title = (await dataviewsAdmin.listFields(dataview.id)).find((f) => f.columnName === "title")!;
      await dataviewsAdmin.updateField(dataview.id, title.id, { gridW: 7 });
      await dataviewsAdmin.publish(dataview.id, null);

      const copy = await dataviewsAdmin.duplicateVersion(dataview.id, 1, { name: "Versioning Copy" });
      expect(copy.slug).toBe("versioning-copy");
      expect(copy.sourceResource).toBe(tableResourceId);
      expect(await dataviewsAdmin.listVersions(copy.id)).toEqual([]);

      const copyFields = await dataviewsAdmin.listFields(copy.id);
      const sourceIds = new Set((await dataviewsAdmin.listFields(dataview.id)).map((f) => f.id));
      expect(copyFields.length).toBe(sourceIds.size);
      expect(copyFields.some((f) => sourceIds.has(f.id))).toBe(false);
      const copyTitle = copyFields.find((f) => f.columnName === "title")!;
      expect(copyTitle.gridW).toBe(7);
      // A widget in the copy sits in the copy's own card, not the source's.
      const copyCard = copyFields.find((f) => f.label === "card")!;
      expect(copyFields.find((f) => f.label === "inCard")?.parent).toBe(copyCard.id);
    });

    it("Save as keeps `owner`: a copy of a Detail's DataView belongs to the same master", async () => {
      const master = await dataviewsAdmin.create({ name: "Versioning Master", sourceResourceId: tableResourceId, viewType: "TABLE" });
      const detail = await dataviewsAdmin.create({ name: "Versioning Owned", sourceResourceId: tableResourceId, viewType: "TABLE" });
      await database.query(`UPDATE totalbase.dataviews SET owner = $2 WHERE id = $1`, [detail.id, master.id]);
      await dataviewsAdmin.publish(detail.id, null);

      const copy = await dataviewsAdmin.duplicateVersion(detail.id, 1, { name: "Versioning Owned Copy" });
      const { rows } = await database.query<{ owner: string | null }>(`SELECT owner FROM totalbase.dataviews WHERE id = $1`, [copy.id]);
      expect(rows[0]!.owner).toBe(master.id);

      const unowned = await dataviewsAdmin.duplicateVersion(master.id, (await dataviewsAdmin.publish(master.id, null)).version, { name: "Versioning Master Copy" });
      const { rows: masterCopy } = await database.query<{ owner: string | null }>(`SELECT owner FROM totalbase.dataviews WHERE id = $1`, [unowned.id]);
      expect(masterCopy[0]!.owner).toBeNull();
    });
  });
});
