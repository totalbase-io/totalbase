import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupAdminContract, type AdminContract } from "./admin-openapi-contract-support.js";

/**
 * The Database area of the Admin API (catalog browsing, schema DDL)
 * against its generated document: every JSON response's `data` carries
 * exactly the documented keys. Everything runs in a scratch schema of its
 * own, dropped afterwards, with its resource rows deleted by id.
 */
describe("Admin OpenAPI matches real responses: catalog and schema", () => {
  let contract: AdminContract;
  const schema = `openapi_contract_db_${randomBytes(4).toString("hex")}`;
  const table = "items";
  const resourceIds = new Set<string>();
  let tableId: string;
  let viewId: string;
  let functionId: string;

  /** Sends `data` as the request body's `{ data }` (Specification_Data_API.md §2.5); no `data`, no body. */
  const send = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, data?: unknown) => {
    const headers = { authorization: `Bearer ${contract.adminToken}` };
    return data === undefined ? contract.app.inject({ method, url, headers }) : contract.app.inject({ method, url, headers, payload: { data } });
  };
  const resourceIdOf = async (relation: string, kind: "regclass" | "regprocedure") => {
    const { rows } = await contract.database.query<{ id: string }>(
      `SELECT id FROM totalbase.resources WHERE postgres_oid = $1::${kind}::oid`,
      [`${schema}.${relation}`],
    );
    expect(rows[0], relation).toBeDefined();
    resourceIds.add(rows[0]!.id);
    return rows[0]!.id;
  };
  const tablePath = "/admin/api/schema/{schema}/tables/{table}";
  const base = () => `/admin/api/schema/${schema}/tables/${table}`;

  beforeAll(async () => {
    contract = await setupAdminContract();
  });

  afterAll(async () => {
    if (contract) {
      await contract.database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      if (resourceIds.size > 0) {
        await contract.database.query(`DELETE FROM totalbase.resources WHERE id = ANY($1::uuid[])`, [[...resourceIds]]);
      }
      await contract.close();
    }
  });

  it("creates the schema and a table", async () => {
    const created = await send("POST", "/admin/api/schema", { name: schema });
    expect(created.statusCode, created.body).toBe(201);
    contract.expectKeys(created.json().data, contract.dataSchema("/admin/api/schema", "post", "201"), "POST /admin/api/schema");

    const body = {
      name: table,
      columns: [
        { name: "id", dataType: "uuid", primaryKey: true, default: "gen_random_uuid()" },
        { name: "name", dataType: "text", nullable: false },
        { name: "price", dataType: "numeric(12,2)", default: "0", check: "price >= 0" },
      ],
    };
    const preview = await send("POST", `/admin/api/schema/${schema}/tables/preview`, body);
    expect(preview.statusCode, preview.body).toBe(200);
    contract.expectKeys(preview.json().data, contract.dataSchema("/admin/api/schema/{schema}/tables/preview", "post"), "POST tables/preview");
    expect(preview.json().data.sql).toContain("create table");
    // The preview ran nothing.
    expect((await contract.database.query(`SELECT to_regclass($1) AS t`, [`"${schema}"."${table}"`])).rows[0]!.t).toBeNull();

    const res = await send("POST", `/admin/api/schema/${schema}/tables`, body);
    expect(res.statusCode, res.body).toBe(201);
    contract.expectKeys(res.json().data, contract.dataSchema("/admin/api/schema/{schema}/tables", "post", "201"), "POST tables");
    tableId = res.json().data.id;
    resourceIds.add(tableId);

    await contract.database.query(`INSERT INTO "${schema}"."${table}" (name, price) VALUES ('one', 1)`);
    await contract.database.query(`CREATE VIEW "${schema}".items_view AS SELECT id, name FROM "${schema}"."${table}"`);
    await contract.database.query(
      `CREATE FUNCTION "${schema}".double_it(value integer, extra integer DEFAULT 0) RETURNS integer LANGUAGE sql AS 'SELECT value * 2 + extra'`,
    );
    const refresh = await send("POST", "/admin/api/catalog/refresh");
    expect(refresh.statusCode, refresh.body).toBe(200);
    contract.expectKeys(refresh.json().data, contract.dataSchema("/admin/api/catalog/refresh", "post"), "POST catalog/refresh");
    viewId = await resourceIdOf("items_view", "regclass");
    functionId = await resourceIdOf("double_it(integer,integer)", "regprocedure");
  });

  it("catalog reads", async () => {
    await contract.expectMatches("/admin/api/catalog/schemas", "/admin/api/catalog/schemas");
    await contract.expectMatches("/admin/api/catalog/tables", "/admin/api/catalog/tables");
    await contract.expectMatches("/admin/api/catalog/views", "/admin/api/catalog/views");
    await contract.expectMatches("/admin/api/catalog/functions", "/admin/api/catalog/functions");
    // Each overload is listed with the signature that tells it apart.
    const functions = (await contract.get("/admin/api/catalog/functions")).json().data as { schema: string; name: string; arguments: string }[];
    expect(functions.find((fn) => fn.schema === schema && fn.name === "double_it")?.arguments).toBe("value integer, extra integer");
    await contract.expectMatches(`/admin/api/catalog/columns?schema=${schema}`, "/admin/api/catalog/columns");
    await contract.expectMatches(`/admin/api/catalog/table/${tableId}`, "/admin/api/catalog/table/{id}");
    await contract.expectMatches(`/admin/api/catalog/table/${tableId}/rows?limit=10`, "/admin/api/catalog/table/{id}/rows");
    await contract.expectMatches(`/admin/api/catalog/table/${tableId}/indexes`, "/admin/api/catalog/table/{id}/indexes");
    await contract.expectMatches(`/admin/api/catalog/table/${tableId}/record`, "/admin/api/catalog/table/{id}/record");
    await contract.expectMatches(`/admin/api/catalog/view/${viewId}`, "/admin/api/catalog/view/{id}");
    await contract.expectMatches(`/admin/api/catalog/view/${viewId}/ddl`, "/admin/api/catalog/view/{id}/ddl");
    await contract.expectMatches(`/admin/api/catalog/function/${functionId}`, "/admin/api/catalog/function/{id}");
    await contract.expectMatches(`/admin/api/catalog/function/${functionId}/ddl`, "/admin/api/catalog/function/{id}/ddl");
    await contract.expectMatches(`/admin/api/schema/${schema}/tables/${table}/indexes`, `${tablePath}/indexes`);

    // One read gives every relation's columns in the schema (the SQL
    // Console's completion - it once fetched each relation's detail apart,
    // a request per table that tripped the rate limit on a large database).
    const columns = (await contract.get(`/admin/api/catalog/columns?schema=${schema}`)).json().data;
    expect(columns).toEqual([
      { oid: expect.any(Number), schema, name: table, resourceType: "TABLE", columns: ["id", "name", "price"] },
      { oid: expect.any(Number), schema, name: "items_view", resourceType: "VIEW", columns: ["id", "name"] },
    ]);
    expect((await contract.get("/admin/api/catalog/columns?schema=pg_catalog")).json().data).toEqual([]);
    expect((await contract.get("/admin/api/catalog/columns")).statusCode).toBe(400);

    // Nested shapes: a column, a CHECK and a function parameter.
    const detail = (await contract.get(`/admin/api/catalog/table/${tableId}`)).json().data;
    const relationDetail = contract.spec.components.schemas["CatalogRelationDetail"]!;
    contract.expectKeys(detail.columns[0], relationDetail.properties!["columns"]!.items!, "catalog column");
    contract.expectKeys(detail.checkConstraints[0], relationDetail.properties!["checkConstraints"]!.items!, "catalog check");
    const fn = (await contract.get(`/admin/api/catalog/function/${functionId}`)).json().data;
    contract.expectKeys(fn.parameters[0], contract.spec.components.schemas["CatalogFunctionDetail"]!.properties!["parameters"]!.items!, "function parameter");
    // The configured role created them, so it owns them and may alter them.
    expect(detail).toMatchObject({ owner: expect.any(String), canAlter: true });
    expect(fn).toMatchObject({ owner: expect.any(String), canAlter: true });
  });

  it("columns and constraints", async () => {
    const column = await send("POST", `${base()}/columns`, { name: "parent", dataType: "uuid" });
    expect(column.statusCode, column.body).toBe(201);
    contract.expectKeys(column.json().data, contract.dataSchema(`${tablePath}/columns`, "post", "201"), "POST columns");
    expect(column.json().data).toEqual({ name: "parent" });

    const patch = await send("PATCH", `${base()}/columns/name`, { default: "'unnamed'" });
    expect([patch.statusCode, patch.body], patch.body).toEqual([204, ""]);

    const unique = await send("POST", `${base()}/unique-constraints`, { columns: ["name"] });
    expect(unique.statusCode, unique.body).toBe(201);
    contract.expectKeys(unique.json().data, contract.dataSchema(`${tablePath}/unique-constraints`, "post", "201"), "POST unique");

    const fk = await send("POST", `${base()}/foreign-keys`, {
      column: "parent", targetSchema: schema, targetTable: table, targetColumn: "id", onDelete: "SET NULL",
    });
    expect(fk.statusCode, fk.body).toBe(201);
    contract.expectKeys(fk.json().data, contract.dataSchema(`${tablePath}/foreign-keys`, "post", "201"), "POST foreign key");

    const check = await send("POST", `${base()}/checks`, { name: "items_name_length", expression: "length(name) > 0", message: "Name can't be empty." });
    expect(check.statusCode, check.body).toBe(201);
    contract.expectKeys(check.json().data, contract.dataSchema(`${tablePath}/checks`, "post", "201"), "POST check");

    // The FK depends on the primary key's index: drop it before replacing the key.
    expect((await send("DELETE", `${base()}/foreign-keys/${fk.json().data.name}`)).statusCode).toBe(204);
    const pk = await send("POST", `${base()}/primary-key`, { columns: ["id"] });
    expect([pk.statusCode, pk.body], pk.body).toEqual([204, ""]);

    expect((await send("DELETE", `${base()}/unique-constraints/${unique.json().data.name}`)).statusCode).toBe(204);
    expect((await send("DELETE", `${base()}/checks/items_name_length`)).statusCode).toBe(204);
    expect((await send("DELETE", `${base()}/primary-key`)).statusCode).toBe(204);
    expect((await send("DELETE", `${base()}/columns/parent`)).statusCode).toBe(204);
  });

  it("lists what names a column that is gone - a dashboard widget's query, for its table", async () => {
    const dashboard = await contract.context.dashboardsAdmin.create({ name: `Broken ${schema.slice(-8)}`, slug: `contract-broken-${schema.slice(-8)}` });
    try {
      const widget = await contract.context.dashboardsAdmin.addWidget(dashboard.id, { type: "KPI", gridX: 0, gridY: 0, gridW: 3, gridH: 2 });
      await contract.context.dashboardsAdmin.updateWidget(dashboard.id, widget.id, { query: `SELECT count(no_such_column) AS value FROM "${schema}"."${table}"` });
      const res = await send("GET", `/admin/api/catalog/broken-references?resource=${tableId}`);
      expect(res.statusCode, res.body).toBe(200);
      const data = res.json().data;
      contract.expectKeys(data, contract.dataSchema("/admin/api/catalog/broken-references"), "GET broken-references");
      const mine = (data.dashboards as { dashboard: { id: string }, code: string }[]).filter(w => w.dashboard.id === dashboard.id);
      expect(mine.map(w => w.code)).toEqual(["UNDEFINED_COLUMN"]);
      contract.expectKeys(mine[0]!, contract.spec.components.schemas["BrokenReferences"]!.properties!["dashboards"]!.items!, "broken widget");
    } finally {
      await contract.context.dashboardsAdmin.delete(dashboard.id);
    }
  });

  it("suggests a table's presentation and applies what was accepted; summarizes and fills every table", async () => {
    expect((await send("POST", `${base()}/columns`, { name: "email", dataType: "text" })).statusCode).toBe(201);
    const path = "/admin/api/resources/{id}/columns/suggested-presentation";
    const url = `/admin/api/resources/${tableId}/columns/suggested-presentation`;
    const preview = await send("GET", url);
    expect(preview.statusCode, preview.body).toBe(200);
    contract.expectKeys(preview.json().data, contract.dataSchema(path), "GET suggested-presentation");
    const email = (preview.json().data.columns as { columnName: string }[]).find(s => s.columnName === "email");
    expect(email).toBeDefined();
    contract.expectKeys(email!, contract.dataSchema(path).properties!["columns"]!.items!, "GET suggested-presentation column");

    const applied = await send("POST", url, { columns: { email: { emptyText: "—" } } });
    expect(applied.statusCode, applied.body).toBe(200);
    contract.expectKeys(applied.json().data[0], contract.dataSchema(path, "post").items!, "POST suggested-presentation");

    const everyPath = "/admin/api/resources/suggested-presentation";
    const summary = await send("GET", everyPath);
    expect(summary.statusCode, summary.body).toBe(200);
    const line = (summary.json().data as { resourceId: string }[]).find(s => s.resourceId === tableId);
    expect(line).toBeDefined();
    contract.expectKeys(line!, contract.dataSchema(everyPath).items!, "GET resources/suggested-presentation");
    const filled = await send("POST", everyPath, { resourceIds: [tableId] });
    expect(filled.statusCode, filled.body).toBe(200);
    contract.expectKeys(filled.json().data, contract.dataSchema(everyPath, "post"), "POST resources/suggested-presentation");
    expect((await send("DELETE", `${base()}/columns/email`)).statusCode).toBe(204);
  });

  it("protects a self-reference against cycles (a TREE's table)", async () => {
    await contract.database.query(`CREATE TABLE "${schema}".tree_items (id integer PRIMARY KEY, parent integer REFERENCES "${schema}".tree_items (id))`);
    try {
      const res = await send("POST", `/admin/api/schema/${schema}/tables/tree_items/cycle-guard`, { parentColumn: "parent" });
      expect([res.statusCode, res.body]).toEqual([204, ""]);
      await contract.database.query(`INSERT INTO "${schema}".tree_items VALUES (1, NULL), (2, 1)`);
      await expect(contract.database.query(`UPDATE "${schema}".tree_items SET parent = 2 WHERE id = 1`)).rejects.toMatchObject({ code: "CHECK_VIOLATION" });
    } finally {
      await contract.database.query(`DROP TABLE "${schema}".tree_items`);
      await contract.database.query(`DROP FUNCTION IF EXISTS "${schema}".tree_items_parent_no_cycle()`);
    }
  });

  it("sets several columns' presentations at once - all or none (M17)", async () => {
    const path = "/admin/api/resources/{id}/columns/presentation";
    const url = `/admin/api/resources/${tableId}/columns/presentation`;
    const res = await send("PUT", url, { columns: { name: { label: "Nombre" }, price: { label: "Precio", displayFormat: "#,##0.00" } } });
    expect(res.statusCode, res.body).toBe(200);
    const saved = res.json().data as { columnName: string; presentation: { label?: string } }[];
    expect(saved.map((c) => [c.columnName, c.presentation.label])).toEqual([["name", "Nombre"], ["price", "Precio"]]);
    contract.expectKeys(saved[0]!, contract.dataSchema(path, "put").items!, "PUT columns/presentation");
    // One unknown column: nothing is written.
    const refused = await send("PUT", url, { columns: { name: { label: "Otro" }, nope: { label: "x" } } });
    expect(refused.statusCode).toBe(404);
    const { rows } = await contract.database.query<{ label: string }>(`SELECT config->>'label' AS label FROM totalbase.resources_columns WHERE resource = $1 AND name = 'name'`, [tableId]);
    expect(rows[0]!.label).toBe("Nombre");
  });

  it("edit batch: preview and apply", async () => {
    const operations = [
      { kind: "add_column", column: { name: "sku", dataType: "text", unique: true } },
      { kind: "set_primary_key", columns: ["id"] },
      { kind: "create_index", name: "items_name_idx", columns: ["name", { name: "price", direction: "desc" }] },
      { kind: "alter_column", column: "price", patch: { dataType: "numeric(14,2)" } },
    ];

    const preview = await send("POST", `${base()}/edit/preview`, { operations });
    expect(preview.statusCode, preview.body).toBe(200);
    contract.expectKeys(preview.json().data, contract.dataSchema(`${tablePath}/edit/preview`, "post"), "POST edit/preview");
    expect(preview.json().data.transactional.join("\n")).toMatch(/numeric\(14, ?2\)/i);
    // The preview ran nothing.
    expect((await contract.database.query(`SELECT to_regclass($1) AS i`, [`"${schema}".items_name_idx`])).rows[0]!.i).toBeNull();

    const res = await send("POST", `${base()}/edit`, { operations });
    expect([res.statusCode, res.body], res.body).toEqual([204, ""]);
    expect((await contract.database.query(`SELECT to_regclass($1) AS i`, [`"${schema}".items_name_idx`])).rows[0]!.i).not.toBeNull();
  });

  it("answers 404 for what doesn't exist, 400 for a body without data", async () => {
    const notFound = async (method: "GET" | "DELETE", url: string) => {
      const res = await send(method, url);
      expect([res.statusCode, res.json().errors?.[0]?.code], `${method} ${url}`).toEqual([404, "RESOURCE_NOT_FOUND"]);
    };
    await notFound("GET", `/admin/api/schema/${schema}/tables/no_such_table/indexes`);
    await notFound("GET", `/admin/api/schema/no_such_schema_${schema}/tables/${table}/indexes`);
    // An id that is neither a uuid nor an OID names nothing - 404, not a cast error.
    for (const route of ["table", "table/{id}/rows", "table/{id}/indexes", "view", "view/{id}/ddl", "function", "function/{id}/ddl"]) {
      const url = route.includes("{id}") ? `/admin/api/catalog/${route.replace("{id}", "not-an-id")}` : `/admin/api/catalog/${route}/not-an-id`;
      await notFound("GET", url);
    }
    await notFound("GET", "/admin/api/catalog/table/00000000-0000-4000-8000-000000000000");
    await notFound("DELETE", "/admin/api/schema/views/not-an-id");
    await notFound("DELETE", "/admin/api/schema/functions/not-an-id");
    await notFound("DELETE", "/admin/api/schema/views/00000000-0000-4000-8000-000000000000");

    // The SQL inside data; a bare body (the old shape) or none at all is a 400.
    for (const url of [`/admin/api/schema/${schema}/tables`, `/admin/api/schema/${schema}/tables/preview`, `${base()}/columns`, `${base()}/edit`]) {
      const bare = await contract.app.inject({ method: "POST", url, headers: { authorization: `Bearer ${contract.adminToken}` }, payload: { name: "x" } });
      expect(bare.statusCode, url).toBe(400);
      expect((await send("POST", url)).statusCode, url).toBe(400);
    }
  });

  it("adds a column with its widget all or nothing: no ACTIVE resource, no column", async () => {
    // A table created outside TotalBase and not synced yet has no resource row.
    await contract.database.query(`CREATE TABLE "${schema}".unsynced (id int PRIMARY KEY)`);
    const res = await send("POST", `/admin/api/schema/${schema}/tables/unsynced/columns`, { name: "due", dataType: "date", input: "date", config: {} });
    expect([res.statusCode, res.json().errors?.[0]?.code]).toEqual([404, "RESOURCE_NOT_FOUND"]);
    const { rows } = await contract.database.query(
      `SELECT 1 FROM pg_attribute WHERE attrelid = $1::regclass AND attname = 'due'`,
      [`"${schema}".unsynced`],
    );
    expect(rows).toHaveLength(0);
    await contract.database.query(`DROP TABLE "${schema}".unsynced`);
  });

  it("returns a view's definition as a complete, runnable CREATE OR REPLACE VIEW", async () => {
    const { ddl } = (await contract.get(`/admin/api/catalog/view/${viewId}/ddl`)).json().data as { ddl: string };
    expect(ddl.startsWith(`CREATE OR REPLACE VIEW ${schema}.items_view AS\n`), ddl).toBe(true);
    await contract.database.query(ddl);
    const fn = (await contract.get(`/admin/api/catalog/function/${functionId}/ddl`)).json().data.ddl as string;
    expect(fn.startsWith("CREATE OR REPLACE FUNCTION"), fn).toBe(true);
  });

  it("rename and drop", async () => {
    const renamed = await send("PATCH", base(), { name: "items_renamed" });
    expect(renamed.statusCode, renamed.body).toBe(200);
    contract.expectKeys(renamed.json().data, contract.dataSchema(tablePath, "patch"), "PATCH table");

    // Same id rules as the catalog routes: the resource id, or its PostgreSQL OID.
    const viewOid = (await contract.database.query<{ oid: string }>(`SELECT postgres_oid::text AS oid FROM totalbase.resources WHERE id = $1`, [viewId])).rows[0]!.oid;
    expect((await send("DELETE", `/admin/api/schema/views/${viewOid}`)).statusCode).toBe(204);
    expect((await send("DELETE", `/admin/api/schema/functions/${functionId}`)).statusCode).toBe(204);
    expect((await send("DELETE", `/admin/api/schema/${schema}/tables/items_renamed`)).statusCode).toBe(204);
  });

  it("documents every catalog and schema route", () => {
    const routes = Object.entries(contract.spec.paths)
      .filter(([path]) => path.startsWith("/admin/api/catalog") || path.startsWith("/admin/api/schema"))
      .flatMap(([path, item]) => Object.entries(item).map(([method, op]) => ({ path, method, op: op as { summary?: string } })));
    expect(routes.length).toBe(37); // 15 catalog + 22 schema
    expect(routes.filter((route) => !route.op.summary).map((route) => `${route.method} ${route.path}`)).toEqual([]);
  });
});
