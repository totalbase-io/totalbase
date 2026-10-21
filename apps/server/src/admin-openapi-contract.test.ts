import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupAdminContract, type AdminContract } from "./admin-openapi-contract-support.js";

describe("Admin OpenAPI matches real responses", () => {
  let contract: AdminContract;
  let context: AdminContract["context"];
  let spec: AdminContract["spec"];
  const get = (url: string) => contract.get(url);
  const declaredKeys: AdminContract["declaredKeys"] = (schema) => contract.declaredKeys(schema);
  const expectMatches: AdminContract["expectMatches"] = (url, path) => contract.expectMatches(url, path);

  beforeAll(async () => {
    contract = await setupAdminContract();
    ({ context, spec } = contract);
  });

  afterAll(async () => {
    await contract.close();
  });

  // Roles and resources are read through the Data API (Security.md §10)
  // - its own generated OpenAPI documents them.
  it("effective permissions", async () => {
    const roleId = (await context.roles.list())[0]!.id;
    await expectMatches(`/admin/api/roles/${roleId}/effective-permissions`, "/admin/api/roles/{id}/effective-permissions");
  });

  // The bulk PUT answers the same Permission rows the single PUT does - on a role of this test's own.
  it("bulk permissions", async () => {
    const role = await context.roles.create("openapi-contract-bulk-permissions-role", { appAccess: true });
    try {
      const resource = (await contract.database.query<{ id: string }>(
        `SELECT id FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = 'users'`,
      )).rows[0]!.id;
      const res = await contract.app.inject({
        method: "PUT",
        url: `/admin/api/roles/${role.id}/permissions`,
        headers: { authorization: `Bearer ${contract.adminToken}` },
        payload: { data: { permissions: [{ resource, action: "READ", effect: "ALLOW", fields: [{ field: "id", effect: "ALLOW" }] }] } },
      });
      expect(res.statusCode, res.body).toBe(200);
      const schema = contract.dataSchema("/admin/api/roles/{role}/permissions", "put");
      expect(res.json().data).toHaveLength(1);
      contract.expectKeys(res.json().data[0], schema.items!, "PUT roles/{role}/permissions");
    } finally {
      await context.roles.delete(role.id);
    }
  });

  it("settings", async () => {
    await expectMatches("/admin/api/settings/schema", "/admin/api/settings/schema");
    await expectMatches("/admin/api/settings/auth/schema", "/admin/api/settings/{group}/schema");
    // A field's optional keys (unit, section, min, ...) vary per setting:
    // every one returned must be documented.
    const documented = new Set(declaredKeys({ $ref: "#/components/schemas/SettingField" }));
    for (const group of ["api", "auth", "files", "smtp", "dataviews", "pool"]) {
      for (const field of (await get(`/admin/api/settings/${group}/schema`)).json().data.fields) {
        expect(Object.keys(field).filter((key) => !documented.has(key)), field.key).toEqual([]);
      }
    }
  });

  it("maintenance", async () => {
    await expectMatches("/admin/api/maintenance/tables", "/admin/api/maintenance/tables");
    const table = (await get("/admin/api/maintenance/tables")).json().data.tables.find((t: { schema: string; name: string }) => t.schema === "totalbase" && t.name === "users");
    const res = await get(`/admin/api/maintenance/tables/${table.oid}/indexes`);
    const documented = new Set(declaredKeys({ $ref: "#/components/schemas/MaintenanceIndex" }));
    expect(Object.keys(res.json().data[0]).sort()).toEqual([...documented].sort());
    const tableKeys = new Set(declaredKeys({ $ref: "#/components/schemas/MaintenanceTable" }));
    expect(Object.keys(table).sort()).toEqual([...tableKeys].sort());
  });

  it("the signed-in admin", async () => {
    await expectMatches("/admin/api/auth/me", "/admin/api/auth/me");
  });

  it("documents every Admin API route - a new route ships with its config.openapi", () => {
    // An undocumented route only gets the "<METHOD> <url>" placeholder summary (admin-spec.ts).
    const undocumented = Object.entries(spec.paths).flatMap(([path, item]) =>
      Object.entries(item as Record<string, { summary?: string }>)
        .filter(([, operation]) => !operation.summary || /^(GET|POST|PUT|PATCH|DELETE) \//.test(operation.summary))
        .map(([method]) => `${method.toUpperCase()} ${path}`),
    );
    expect(undocumented).toEqual([]);
  });
});
