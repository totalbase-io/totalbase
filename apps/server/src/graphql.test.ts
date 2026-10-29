import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createTestApiToken, setupTestApp, uniqueSuffix } from "./test-support.js";

/**
 * The GraphQL API (Data_API.md §17): the caller's schema lists only what their grants allow, each
 * root field runs the REST read or write path - field grants, row filters, relation paths, constraints, audit
 * - and errors carry the REST code and status.
 */
describe("GraphQL API", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let roleId: string;
  let token: string;
  let userId: string;
  let tokenId: string;
  const resourceIds: string[] = [];
  let productsId: string;

  const BRANDS = "graphql_test_brands";
  const PRODUCTS = "graphql_test_products";
  const CHEAP = "graphql_test_cheap";
  const LINES = "graphql_test_lines";
  let linesId: string;
  const DOUBLE = "graphql_test_double";
  const RENAME = "graphql_test_rename";
  const P = PRODUCTS; // public is graphql.default_schema: no prefix

  const gql = (query: string, variables?: Record<string, unknown>, bearer: string | null = token) =>
    app.inject({
      method: "POST",
      url: "/api/graphql",
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      payload: { query, ...(variables && { variables }) },
    });

  async function expose(name: string, methods: string[], type: "TABLE" | "VIEW" | "FUNCTION" = "TABLE", signature = name, functionClass: string | null = null): Promise<string> {
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods, function_class)
       VALUES (CASE WHEN $4 = 'FUNCTION' THEN to_regprocedure($1)::oid ELSE to_regclass($1)::oid END, 'public', $2, $4, 'ACTIVE', $3, $5)
       RETURNING id`,
      [`public.${signature}`, name, methods, type, functionClass],
    );
    resourceIds.push(rows[0]!.id);
    return rows[0]!.id;
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await database.query(`DROP FUNCTION IF EXISTS public.${DOUBLE}(integer), public.${RENAME}(text, text)`);
    await database.query(`DROP VIEW IF EXISTS public.${CHEAP}`);
    await database.query(`DROP TABLE IF EXISTS public.${LINES}, public.${PRODUCTS}, public.${BRANDS} CASCADE`);
    await database.query(`CREATE TABLE public.${BRANDS} (id serial PRIMARY KEY, name text NOT NULL, secret text)`);
    await database.query(
      `CREATE TABLE public.${PRODUCTS} (
         id serial PRIMARY KEY, name text NOT NULL, price integer NOT NULL CHECK (price >= 0),
         brand integer REFERENCES public.${BRANDS}(id), hidden text, created_at timestamptz NOT NULL DEFAULT now())`,
    );
    await database.query(`INSERT INTO public.${BRANDS} (id, name, secret) VALUES (1, 'Acme', 's1'), (2, 'Globex', 's2')`);
    await database.query(
      `INSERT INTO public.${PRODUCTS} (name, price, brand, hidden) VALUES
         ('anvil', 100, 1, 'h'), ('rocket', 900, 1, 'h'), ('widget', 50, 2, 'h'), ('loose', 10, NULL, 'h'), ('vault', 5000, 2, 'h')`,
    );
    await database.query(
      `CREATE TABLE public.${LINES} (id serial PRIMARY KEY, product integer NOT NULL REFERENCES public.${PRODUCTS}(id), qty integer NOT NULL, secret text)`,
    );
    await database.query(
      `INSERT INTO public.${LINES} (product, qty, secret)
       SELECT p.id, q.qty, 's' FROM public.${PRODUCTS} p CROSS JOIN (VALUES (1), (2), (500)) AS q(qty) WHERE p.name IN ('anvil', 'rocket')`,
    );
    await database.query(`CREATE VIEW public.${CHEAP} AS SELECT id, name, price FROM public.${PRODUCTS} WHERE price < 200`);
    await database.query(`CREATE FUNCTION public.${DOUBLE}(n integer) RETURNS integer LANGUAGE sql AS 'SELECT n * 2'`);
    await database.query(
      `CREATE FUNCTION public.${RENAME}(old_name text, new_name text DEFAULT 'renamed') RETURNS SETOF public.${PRODUCTS} LANGUAGE sql
       AS $$UPDATE public.${PRODUCTS} SET name = new_name WHERE name = old_name RETURNING *$$`,
    );
    await expose(BRANDS, ["GET"]);
    const cheapId = await expose(CHEAP, ["GET"], "VIEW");
    linesId = await expose(LINES, ["GET", "POST"]);
    await database.query(`UPDATE totalbase.resources SET audit_read = true WHERE id = $1`, [linesId]);
    const doubleId = await expose(DOUBLE, ["POST"], "FUNCTION", `${DOUBLE}(integer)`, "QUERY");
    const renameId = await expose(RENAME, ["POST"], "FUNCTION", `${RENAME}(text, text)`, "ACTION");
    productsId = await expose(PRODUCTS, ["GET", "POST", "PATCH", "DELETE"]);

    roleId = (await context.roles.create(`graphql-test-role-${uniqueSuffix()}`, { apiAccess: true })).id;
    const allow = (fields: string[]) => fields.map((field) => ({ field, effect: "ALLOW" as const }));
    // Rows priced over 1000 are out of reach; brand.name is granted, brand.secret is not.
    const where = { price: { _lte: "1000" } };
    await context.permissions.set(roleId, productsId, "READ", { effect: "ALLOW", fields: allow(["id", "name", "price", "brand", "brand.name", "created_at"]), where });
    await context.permissions.set(roleId, productsId, "CREATE", { effect: "ALLOW", fields: allow(["name", "price", "brand"]) });
    await context.permissions.set(roleId, productsId, "UPDATE", { effect: "ALLOW", fields: allow(["name", "price"]), where });
    await context.permissions.set(roleId, productsId, "DELETE", { effect: "ALLOW", fields: [], where });
    await context.permissions.set(roleId, cheapId, "READ", { effect: "ALLOW", fields: allow(["id", "name"]) });
    // The lines' own grant: no secret, and no line of 100 or more.
    await context.permissions.set(roleId, linesId, "CREATE", { effect: "ALLOW", fields: allow(["product", "qty"]) });
    await context.permissions.set(roleId, linesId, "READ", { effect: "ALLOW", fields: allow(["id", "product", "qty", "product.name"]), where: { qty: { _lt: "100" } } });
    await context.permissions.set(roleId, doubleId, "EXECUTE", { effect: "ALLOW" });
    await context.permissions.set(roleId, renameId, "EXECUTE", { effect: "ALLOW" });
    ({ plainKey: token, userId, tokenId } = await createTestApiToken(context, {
      name: "graphql-test-key",
      roleId,
      email: `graphql-test-${uniqueSuffix()}@example.com`,
    }));
    await context.settings.set("graphql.enabled", true);
  });

  afterAll(async () => {
    await context.settings.set("graphql.enabled", false);
    await context.settings.set("graphql.max_calls", 10);
    await context.settings.set("graphql.default_schema", "public");
    for (const id of resourceIds) {
      await database.query(`DELETE FROM totalbase.logs WHERE resource = $1`, [id]);
      await database.query(`DELETE FROM totalbase.outbox WHERE resource = $1`, [id]);
    }
    await database.query(`DELETE FROM totalbase.tokens WHERE id = $1`, [tokenId]);
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [userId]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = ANY($1)`, [resourceIds]);
    await database.query(`DROP FUNCTION IF EXISTS public.${DOUBLE}(integer), public.${RENAME}(text, text)`);
    await database.query(`DROP VIEW IF EXISTS public.${CHEAP}`);
    await database.query(`DROP TABLE IF EXISTS public.${LINES}, public.${PRODUCTS}, public.${BRANDS} CASCADE`);
    await app.close();
    await database.close();
  });

  it("is 404 while graphql.enabled is off, and 401 without a token", async () => {
    await context.settings.set("graphql.enabled", false);
    expect((await gql("{ __typename }")).statusCode).toBe(404);
    await context.settings.set("graphql.enabled", true);
    const anonymous = await gql("{ __typename }", undefined, null);
    expect(anonymous.statusCode).toBe(401);
  });

  it("lists only the granted columns, relation paths and operations", async () => {
    const response = await gql(`{
      row: __type(name: "${P}") { fields { name } }
      brand: __type(name: "${P}__brand_row") { fields { name } }
      create: __type(name: "${P}_create") { inputFields { name type { kind } } }
      schema: __schema { queryType { fields { name } } mutationType { fields { name } } }
    }`);
    expect(response.statusCode).toBe(200);
    const { row, brand, create, schema } = response.json().data;
    expect(row.fields.map((f: { name: string }) => f.name).sort()).toEqual(["_version", "brand", "brand_row", "created_at", `${LINES}_by_product`, "id", "name", "price"]);
    expect(brand.fields.map((f: { name: string }) => f.name)).toEqual(["name"]);
    // Required on create: NOT NULL without a default.
    expect(Object.fromEntries(create.inputFields.map((f: { name: string; type: { kind: string } }) => [f.name, f.type.kind]))).toEqual({
      name: "NON_NULL",
      price: "NON_NULL",
      brand: "SCALAR",
      // A nested create's children (they need CREATE on the lines).
      [`${LINES}_by_product`]: "LIST",
    });
    const queries = schema.queryType.fields.map((f: { name: string }) => f.name);
    expect(queries).toContain(P);
    expect(queries).toContain(`${P}_by_pk`);
    // brands is reachable through the relation, but this role has no grant on it.
    expect(queries).not.toContain(`${BRANDS}`);
    expect(schema.mutationType.fields.map((f: { name: string }) => f.name)).toEqual(
      expect.arrayContaining([`${P}_insert`, `${P}_insert_one`, `${P}_update`, `${P}_update_by_pk`, `${P}_delete`, `${P}_delete_by_pk`]),
    );
  });

  it("reads with where, order_by and relations, within the row filter", async () => {
    const response = await gql(`{
      ${P}(where: { _or: [{ brand_row: { name: { _eq: "Acme" } } }, { brand: { _null: true } }] }, order_by: [{ price: DESC }]) {
        name price brand_row { name }
      }
    }`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        [P]: [
          { name: "rocket", price: 900, brand_row: { name: "Acme" } },
          { name: "anvil", price: 100, brand_row: { name: "Acme" } },
          { name: "loose", price: 10, brand_row: null },
        ],
      },
    });

    // The row filter holds for a relation's order and by key alike: vault (5000) is never there.
    const ordered = await gql(`{ ${P}(order_by: [{ brand_row: { name: DESC } }, { name: ASC }], limit: 2) { name } }`);
    // PostgreSQL orders NULLs first under DESC: the product without a brand leads.
    expect(ordered.json().data[P]).toEqual([{ name: "loose" }, { name: "widget" }]);
    const vault = (await database.query<{ id: number }>(`SELECT id FROM public.${PRODUCTS} WHERE name = 'vault'`)).rows[0]!.id;
    const byKey = await gql(`query ($id: Int!) { ${P}_by_pk(id: $id) { name } }`, { id: vault });
    expect(byKey.json()).toEqual({ data: { [`${P}_by_pk`]: null } });
  });

  it("refuses a column the grant doesn't allow before running anything", async () => {
    const hidden = await gql(`{ ${P} { name hidden } }`);
    expect(hidden.statusCode).toBe(400);
    expect(hidden.json().errors[0].extensions.code).toBe("INVALID_QUERY");
    const secret = await gql(`{ ${P}(where: { brand_row: { secret: { _eq: "s1" } } }) { name } }`);
    expect(secret.statusCode).toBe(400);
  });

  it("writes through the Data API's write path, audited, with each field's error on its own", async () => {
    const inserted = await gql(`mutation {
      ok: ${P}_insert_one(data: { name: "gizmo", price: 20, brand: 2 }) { id name price }
      bad: ${P}_insert_one(data: { name: "broken", price: -1 }) { id }
    }`);
    expect(inserted.statusCode).toBe(200);
    const body = inserted.json();
    expect(body.data.ok).toMatchObject({ name: "gizmo", price: 20 });
    expect(body.data.bad).toBeNull();
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].path).toEqual(["bad"]);
    expect(body.errors[0].extensions).toMatchObject({ code: "CHECK_VIOLATION", status: 422 });

    const id = body.data.ok.id as number;
    const updated = await gql(`mutation ($id: Int!) { ${P}_update_by_pk(id: $id, data: { price: 25 }) { price } }`, { id });
    expect(updated.json()).toEqual({ data: { [`${P}_update_by_pk`]: { price: 25 } } });

    // UPDATE and DELETE by where stay inside the row filter: vault is out of reach.
    const deleted = await gql(`mutation { ${P}_delete(where: { name: { _in: ["gizmo", "vault"] } }) { name } }`);
    expect(deleted.json()).toEqual({ data: { [`${P}_delete`]: [{ name: "gizmo" }] } });

    const { rows } = await database.query<{ action: string }>(
      `SELECT action FROM totalbase.logs WHERE resource = $1 AND action <> 'READ' AND status = 'EXECUTED' ORDER BY started_at`,
      [productsId],
    );
    expect(rows.map((r) => r.action)).toEqual(["CREATE", "UPDATE", "DELETE"]);
  });

  it("reads a view and counts, within the row filter", async () => {
    const response = await gql(`{
      ${CHEAP}(order_by: [{ name: ASC }]) { name }
      all: ${P}_count
      acme: ${P}_count(where: { brand_row: { name: { _eq: "Acme" } } })
      views: __schema { mutationType { fields { name } } }
    }`);
    expect(response.statusCode).toBe(200);
    const { data } = response.json();
    expect(data[`${CHEAP}`]).toEqual([{ name: "anvil" }, { name: "loose" }, { name: "widget" }]);
    // vault (5000) is out of the row filter's reach, as in a list.
    expect(data.all).toBe(4);
    expect(data.acme).toBe(2);
    // A view is read-only: no mutation of it.
    expect(data.views.mutationType.fields.map((f: { name: string }) => f.name).filter((n: string) => n.includes(CHEAP))).toEqual([]);
  });

  it("calls a QUERY function as a query and an ACTION one as a mutation", async () => {
    const schema = (await gql(`{ __schema { queryType { fields { name } } mutationType { fields { name } } } }`)).json().data.__schema;
    expect(schema.queryType.fields.map((f: { name: string }) => f.name)).toContain(`${DOUBLE}`);
    expect(schema.mutationType.fields.map((f: { name: string }) => f.name)).toContain(`${RENAME}`);

    expect((await gql(`{ ${DOUBLE}(n: 21) }`)).json()).toEqual({ data: { [`${DOUBLE}`]: 42 } });
    // A required argument is required by GraphQL; a defaulted one may be left to PostgreSQL.
    expect((await gql(`{ ${DOUBLE} }`)).statusCode).toBe(400);
    // Typed as PostgreSQL declares the result: a scalar's type, a row's columns.
    const type = async (name: string) => (await gql(`{ __type(name: "${name}") { fields { name type { name kind ofType { name kind ofType { kind ofType { name } } } } } } }`)).json().data.__type;
    const queryFields = (await type("Query")).fields as { name: string; type: { name: string } }[];
    expect(queryFields.find((f) => f.name === DOUBLE)!.type.name).toBe("Int");
    const mutationFields = (await type("Mutation")).fields as { name: string; type: unknown }[];
    expect(mutationFields.find((f) => f.name === RENAME)!.type).toMatchObject({ kind: "NON_NULL", ofType: { kind: "LIST", ofType: { kind: "OBJECT" } } });
    const returned = ((await type(`${RENAME}_returns`)).fields as { name: string }[]).map((f) => f.name);
    expect(returned).toEqual(expect.arrayContaining(["name", "price"]));
    expect((await gql(`mutation { ${RENAME}(old_name: "widget") }`)).statusCode).toBe(400);
    const renamed = await gql(`mutation { ${RENAME}(old_name: "widget") { name price } }`);
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().data[`${RENAME}`]).toEqual([{ name: "renamed", price: 50 }]);
  });

  it("names graphql.default_schema's objects without a prefix, and every other schema's {schema}__{name}", async () => {
    await context.settings.set("graphql.default_schema", "sales");
    const fields = (await gql(`{ __schema { queryType { fields { name } } } }`)).json().data.__schema.queryType.fields.map((f: { name: string }) => f.name);
    await context.settings.set("graphql.default_schema", "public");
    expect(fields).toContain(`public__${PRODUCTS}`);
    expect(fields).not.toContain(PRODUCTS);
    const read = await gql(`{ ${P}(where: { name: { _eq: "anvil" } }) { name } }`);
    expect(read.json()).toEqual({ data: { [P]: [{ name: "anvil" }] } });
  });

  it("reads one-to-many with the child table's own grants, in one read per field however many parents", async () => {
    const before = Number((await database.query<{ n: string }>(`SELECT count(*) AS n FROM totalbase.logs WHERE resource = $1 AND action = 'READ'`, [linesId])).rows[0]!.n);
    const response = await gql(`{
      ${P}(where: { name: { _in: ["anvil", "loose", "rocket"] } }, order_by: [{ name: ASC }]) {
        name
        lines: ${LINES}_by_product(order_by: [{ qty: DESC }]) { qty product_row { name } }
      }
    }`);
    expect(response.json().errors).toBeUndefined();
    expect(response.statusCode).toBe(200);
    // The 500 lines are outside the lines' row filter; loose has none.
    expect(response.json()).toEqual({
      data: {
        [P]: [
          { name: "anvil", lines: [{ qty: 2, product_row: { name: "anvil" } }, { qty: 1, product_row: { name: "anvil" } }] },
          { name: "loose", lines: [] },
          { name: "rocket", lines: [{ qty: 2, product_row: { name: "rocket" } }, { qty: 1, product_row: { name: "rocket" } }] },
        ],
      },
    });
    const after = Number((await database.query<{ n: string }>(`SELECT count(*) AS n FROM totalbase.logs WHERE resource = $1 AND action = 'READ'`, [linesId])).rows[0]!.n);
    expect(after - before).toBe(1);

    // limit and offset are each parent's, still one read.
    const limited = await gql(`{
      ${P}(where: { name: { _in: ["anvil", "rocket"] } }, order_by: [{ name: ASC }]) {
        name
        top: ${LINES}_by_product(order_by: [{ qty: DESC }], limit: 1) { qty }
        rest: ${LINES}_by_product(order_by: [{ qty: DESC }], limit: 5, offset: 1) { qty }
      }
    }`);
    expect(limited.json()).toEqual({
      data: {
        [P]: [
          { name: "anvil", top: [{ qty: 2 }], rest: [{ qty: 1 }] },
          { name: "rocket", top: [{ qty: 2 }], rest: [{ qty: 1 }] },
        ],
      },
    });

    // The child's own field grant decides: secret isn't in the lines' type.
    const secret = await gql(`{ ${P} { ${LINES}_by_product { secret } } }`);
    expect(secret.statusCode).toBe(400);
  });

  it("reads a row's _version, and refuses an update or delete by key over a newer one", async () => {
    const id = (await database.query<{ id: number }>(`INSERT INTO public.${PRODUCTS} (name, price) VALUES ('versioned', 1) RETURNING id`)).rows[0]!.id;
    const read = async () => (await gql(`query ($id: Int!) { ${P}_by_pk(id: $id) { name _version } }`, { id })).json().data[`${P}_by_pk`];
    const { _version: first } = await read();
    expect(first).toMatch(/^\d+$/);

    const updated = await gql(`mutation ($id: Int!, $v: String) { ${P}_update_by_pk(id: $id, data: { price: 2 }, version: $v) { price _version } }`, { id, v: first });
    const second = updated.json().data[`${P}_update_by_pk`]._version;
    expect(updated.json().data[`${P}_update_by_pk`].price).toBe(2);
    expect(second).toBe((await read())._version);
    expect(second).not.toBe(first);

    // The version read before is stale now.
    const stale = await gql(`mutation ($id: Int!, $v: String) { ${P}_delete_by_pk(id: $id, version: $v) { id } }`, { id, v: first });
    expect(stale.json().errors[0].extensions).toMatchObject({ code: "ROW_VERSION_CONFLICT", status: 409 });
    const current = await gql(`mutation ($id: Int!, $v: String) { ${P}_delete_by_pk(id: $id, version: $v) { id } }`, { id, v: second });
    expect(current.json()).toEqual({ data: { [`${P}_delete_by_pk`]: { id } } });
  });

  it("replays a mutation sent again with its Idempotency-Key, and refuses a create without one where the table requires it", async () => {
    const send = (key: string | undefined, name: string) =>
      app.inject({
        method: "POST",
        url: "/api/graphql",
        headers: { authorization: `Bearer ${token}`, ...(key && { "idempotency-key": key }) },
        payload: { query: `mutation ($n: String!) { ${P}_insert_one(data: { name: $n, price: 3 }) { id name } }`, variables: { n: name } },
      });
    const key = `graphql-${uniqueSuffix()}`;
    const first = await send(key, "once");
    const again = await send(key, "once");
    expect(again.json()).toEqual(first.json());
    expect((await database.query(`SELECT 1 FROM public.${PRODUCTS} WHERE name = 'once'`)).rowCount).toBe(1);
    // The same key with another request is refused.
    expect((await send(key, "other")).statusCode).toBeGreaterThanOrEqual(400);

    await database.query(`UPDATE totalbase.resources SET require_idempotency_key = true WHERE id = $1`, [productsId]);
    try {
      const without = await send(undefined, "keyless");
      expect(without.json().errors[0].extensions.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
      expect((await send(`graphql-${uniqueSuffix()}`, "keyed")).json().data[`${P}_insert_one`]).toMatchObject({ name: "keyed" });
    } finally {
      await database.query(`UPDATE totalbase.resources SET require_idempotency_key = false WHERE id = $1`, [productsId]);
    }
  });

  it("creates a row with its children in one transaction, each under the child table's own CREATE", async () => {
    const created = await gql(`mutation {
      ${P}_insert_one(data: { name: "kit", price: 9, ${LINES}_by_product: [{ qty: 3 }, { qty: 4 }] }) {
        name
        ${LINES}_by_product { qty product }
      }
    }`);
    expect(created.json().errors).toBeUndefined();
    const row = created.json().data[`${P}_insert_one`];
    expect(row.name).toBe("kit");
    expect(row[`${LINES}_by_product`].map((line: { qty: number }) => line.qty)).toEqual([3, 4]);
    const { rows } = await database.query<{ qty: number }>(
      `SELECT l.qty FROM public.${LINES} l JOIN public.${PRODUCTS} p ON p.id = l.product WHERE p.name = 'kit' ORDER BY l.qty`,
    );
    expect(rows.map((r) => r.qty)).toEqual([3, 4]);

    // The child's foreign key is TotalBase's to set: not in the child's input.
    const withKey = await gql(`mutation { ${P}_insert_one(data: { name: "kit2", price: 1, ${LINES}_by_product: [{ qty: 1, product: 1 }] }) { name } }`);
    expect(withKey.statusCode).toBe(400);

    // One child refused (its CHECK) rolls the parent back too.
    await database.query(`ALTER TABLE public.${LINES} ADD CONSTRAINT graphql_test_lines_qty CHECK (qty > 0)`);
    try {
      const refused = await gql(`mutation { ${P}_insert_one(data: { name: "kit3", price: 1, ${LINES}_by_product: [{ qty: 1 }, { qty: 0 }] }) { name } }`);
      expect(refused.json().errors[0].extensions.code).toBe("CHECK_VIOLATION");
      expect((await database.query(`SELECT 1 FROM public.${PRODUCTS} WHERE name = 'kit3'`)).rowCount).toBe(0);
    } finally {
      await database.query(`ALTER TABLE public.${LINES} DROP CONSTRAINT graphql_test_lines_qty`);
    }
  });

  it("refuses more child rows than api.max_limit rather than cutting them", async () => {
    await context.settings.set("api.max_limit", 3);
    const response = await gql(`{ ${P}(where: { name: { _in: ["anvil", "rocket"] } }) { name ${LINES}_by_product { qty } } }`);
    await context.settings.set("api.max_limit", 500);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toBeNull();
    expect(body.errors[0].extensions.code).toBe("QUERY_COMPLEXITY_LIMIT_EXCEEDED");
  });

  it("refuses more Data API calls than graphql.max_calls - one-to-many fields included", async () => {
    await context.settings.set("graphql.max_calls", 1);
    const twoRoots = await gql(`{ a: ${P} { id } b: ${P} { id } }`);
    const withChildren = await gql(`{ ${P} { id ${LINES}_by_product { qty } } }`);
    await context.settings.set("graphql.max_calls", 10);
    for (const response of [twoRoots, withChildren]) {
      expect(response.statusCode).toBe(400);
      expect(response.json().errors[0].extensions.code).toBe("QUERY_COMPLEXITY_LIMIT_EXCEEDED");
    }
  });
});
