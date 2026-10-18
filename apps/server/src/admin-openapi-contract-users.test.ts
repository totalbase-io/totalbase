import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupAdminContract, type AdminContract } from "./admin-openapi-contract-support.js";

/**
 * Admin OpenAPI contract for users, sessions, tokens, secrets, auth
 * providers and system emails: each documented response's `data` carries
 * exactly the properties the real response has. Fixtures are prefixed
 * `oac-users` and removed by primary key.
 */
describe("Admin OpenAPI matches real responses: users and credentials", () => {
  let contract: AdminContract;
  const suffix = randomBytes(4).toString("hex");
  const email = `oac-users-${suffix}@example.com`;
  const secretKey = `oac-users-${suffix}`;
  let roleId: string | undefined;
  let userId: string | undefined;
  let tokenId: string | undefined;
  let secretId: string | undefined;
  let providerId: string | undefined;

  /** `data` goes in the `{ data }` request envelope (Specification_Data_API.md §2.5). */
  const inject = (method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, data?: unknown) =>
    contract.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${contract.adminToken}` },
      ...(data === undefined ? {} : { payload: { data } as Record<string, unknown> }),
    });
  /** A documented 204: no body. */
  const expectNoContent = (path: string, method: string) => {
    const responses = contract.spec.paths[path]![method]!.responses;
    expect(responses["204"], `${method} ${path}`).toBeDefined();
    expect(Object.keys(responses).filter((status) => status.startsWith("2")), `${method} ${path}`).toEqual(["204"]);
  };

  beforeAll(async () => {
    contract = await setupAdminContract();
    roleId = (await contract.context.roles.create(`oac-users ${suffix}`, { apiAccess: true })).id;
  });

  afterAll(async () => {
    const { database } = contract;
    if (providerId) await database.query(`DELETE FROM totalbase.providers WHERE id = $1`, [providerId]);
    if (secretId) await database.query(`DELETE FROM totalbase.secrets WHERE id = $1`, [secretId]);
    if (tokenId) await database.query(`DELETE FROM totalbase.tokens WHERE id = $1`, [tokenId]);
    if (userId) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [userId]);
    if (roleId) await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await contract.close();
  });

  it("users", async () => {
    const create = await inject("POST", "/admin/api/users", { email, name: "OAC users", roleIds: [roleId] });
    expect(create.statusCode, create.body).toBe(201);
    userId = create.json().data.id;
    contract.expectKeys(create.json().data, contract.dataSchema("/admin/api/users", "post", "201"), "POST /admin/api/users");

    await contract.expectMatches("/admin/api/users", "/admin/api/users");
    expect(Object.keys((await contract.get("/admin/api/users")).json().meta)).toEqual(["total"]);
    await contract.expectMatches(`/admin/api/users?limit=5&ids=${userId}`, "/admin/api/users");
    expect((await contract.get(`/admin/api/users?limit=5&ids=${userId}`)).json().meta).toEqual({ total: 1 });
    await contract.expectMatches("/admin/api/users/summary", "/admin/api/users/summary");
    // A test database has no column of a project's: an empty list (the rows' shape is covered in admin-users-extra.test.ts).
    const projectColumns = await contract.get("/admin/api/users/project-columns");
    expect([projectColumns.statusCode, Array.isArray(projectColumns.json().data)]).toEqual([200, true]);
    await contract.expectMatches(`/admin/api/users/${userId}`, "/admin/api/users/{id}");

    // An array of role ids, not of objects.
    const roles = await contract.get(`/admin/api/users/${userId}/roles`);
    expect(roles.json().data).toEqual([roleId]);
    expect(contract.dataSchema("/admin/api/users/{id}/roles").items).toEqual({ type: "string", format: "uuid" });

    const setRoles = await inject("PUT", `/admin/api/users/${userId}/roles`, { roleIds: [roleId] });
    expect(setRoles.statusCode, setRoles.body).toBe(204);
    expectNoContent("/admin/api/users/{id}/roles", "put");

    const password = await inject("PUT", `/admin/api/users/${userId}/password`, { password: `oac-users-${suffix}-password`, signOut: false });
    expect(password.statusCode, password.body).toBe(204);
    expectNoContent("/admin/api/users/{id}/password", "put");

    const changeEmail = await inject("PUT", `/admin/api/users/${userId}/email`, { email: `oac-users-${suffix}-2@example.com`, verification: "VERIFIED" });
    expect(changeEmail.statusCode, changeEmail.body).toBe(200);
    contract.expectKeys(changeEmail.json().data, contract.dataSchema("/admin/api/users/{id}/email", "put"), "PUT email");
    expect(changeEmail.json().meta).toEqual({ verificationSent: false });

    for (const action of ["invite", "reset-password"]) {
      const res = await inject("POST", `/admin/api/users/${userId}/${action}`, { delivery: "link" });
      expect(res.statusCode, res.body).toBe(200);
      contract.expectKeys(res.json().data, contract.dataSchema(`/admin/api/users/{id}/${action}`, "post"), action);
    }

    // Avatar: a 1x1 PNG as multipart "file", then removed again (its file too).
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    const boundary = `oac-users-${suffix}`;
    const multipartBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const upload = await contract.app.inject({
      method: "POST",
      url: `/admin/api/users/${userId}/avatar`,
      headers: { authorization: `Bearer ${contract.adminToken}`, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody,
    });
    expect(upload.statusCode, upload.body).toBe(200);
    contract.expectKeys(upload.json().data, contract.dataSchema("/admin/api/users/{id}/avatar", "post"), "POST avatar");
    expectNoContent("/admin/api/users/{id}/avatar", "delete");
    expect((await inject("DELETE", `/admin/api/users/${userId}/avatar`)).statusCode).toBe(204);
    expectNoContent("/admin/api/users/{id}", "delete");
  });

  it("sessions", async () => {
    await contract.expectMatches("/admin/api/sessions?limit=5", "/admin/api/sessions");
    const paged = (await contract.get("/admin/api/sessions?limit=5")).json();
    expect(Object.keys(paged.meta).sort()).toEqual(["counts", "total"]);
    // Without `limit`: the same row shape and the same meta.
    await contract.expectMatches("/admin/api/sessions", "/admin/api/sessions");
    expect(Object.keys((await contract.get("/admin/api/sessions")).json().meta).sort()).toEqual(["counts", "total"]);
  });

  it("tokens", async () => {
    expect(userId, "the users test creates the token's owner").toBeDefined();
    const create = await inject("POST", "/admin/api/tokens", { userId, name: `oac-users-${suffix}`, plane: "API", ttlDays: 1 });
    expect(create.statusCode, create.body).toBe(201);
    tokenId = create.json().data.id;
    contract.expectKeys(create.json().data, contract.dataSchema("/admin/api/tokens", "post", "201"), "POST /admin/api/tokens");

    const rotate = await inject("POST", `/admin/api/tokens/${tokenId}/rotate`, { ttlDays: 2 });
    expect(rotate.statusCode, rotate.body).toBe(200);
    contract.expectKeys(rotate.json().data, contract.dataSchema("/admin/api/tokens/{id}/rotate", "post"), "rotate");
  });

  it("secrets", async () => {
    const put = await inject("PUT", `/admin/api/secrets/${secretKey}`, { value: "oac-users-secret" });
    expect(put.statusCode, put.body).toBe(200);
    secretId = (await contract.database.query<{ id: string }>(`SELECT id FROM totalbase.secrets WHERE key = $1`, [secretKey])).rows[0]!.id;
    contract.expectKeys(put.json().data, contract.dataSchema("/admin/api/secrets/{key}", "put"), "PUT secret");
    await contract.expectMatches("/admin/api/secrets", "/admin/api/secrets");
    expectNoContent("/admin/api/secrets/{key}", "delete");
  });

  it("auth providers", async () => {
    expect(secretId, "the secrets test creates the client secret").toBeDefined();
    const configuration = { client_id: "oac-users", client_secret_key: secretKey, allowed_redirect_urls: ["https://example.com/"], issuer: "https://example.com" };
    const create = await inject("POST", "/admin/api/auth-providers", { type: "OIDC", name: `OAC users ${suffix}`, enabled: false, configuration });
    expect(create.statusCode, create.body).toBe(201);
    providerId = create.json().data.id;
    contract.expectKeys(create.json().data, contract.dataSchema("/admin/api/auth-providers", "post", "201"), "POST auth-providers");

    await contract.expectMatches("/admin/api/auth-providers", "/admin/api/auth-providers");
    await contract.expectMatches(`/admin/api/auth-providers/${providerId}`, "/admin/api/auth-providers/{id}");
    await contract.expectMatches(`/admin/api/auth-providers/${providerId}/redirect-uri`, "/admin/api/auth-providers/{id}/redirect-uri");
    // Every key the stored configuration has is documented.
    const documented = contract.declaredKeys({ $ref: "#/components/schemas/AuthProvidersConfiguration" });
    expect(Object.keys(create.json().data.configuration).filter((key) => !documented.includes(key))).toEqual([]);

    const patch = await inject("PATCH", `/admin/api/auth-providers/${providerId}`, { name: `OAC users ${suffix} 2` });
    expect(patch.statusCode, patch.body).toBe(200);
    contract.expectKeys(patch.json().data, contract.dataSchema("/admin/api/auth-providers/{id}", "patch"), "PATCH auth-providers");

    const remove = await inject("DELETE", `/admin/api/auth-providers/${providerId}`);
    expect(remove.statusCode, remove.body).toBe(204);
    expectNoContent("/admin/api/auth-providers/{id}", "delete");
    // Gone now: a second DELETE is 404.
    const again = await inject("DELETE", `/admin/api/auth-providers/${providerId}`);
    expect([again.statusCode, again.json().errors[0].code]).toEqual([404, "AUTH_PROVIDER_NOT_FOUND"]);
    providerId = undefined;
  });

  it("SMTP connection test is a 204 with no request body", () => {
    expectNoContent("/admin/api/settings/mail/verify", "post");
    expect((contract.spec.paths["/admin/api/settings/mail/verify"]!.post as { requestBody?: unknown }).requestBody).toBeUndefined();
  });

  it("documents every JSON request body in the { data } envelope", () => {
    const routes: Array<[string, string]> = [
      ["/admin/api/users", "post"], ["/admin/api/users/{id}/password", "put"], ["/admin/api/users/{id}/email", "put"],
      ["/admin/api/users/{id}/invite", "post"], ["/admin/api/users/{id}/reset-password", "post"], ["/admin/api/users/{id}/roles", "put"],
      ["/admin/api/tokens", "post"], ["/admin/api/tokens/{id}/rotate", "post"], ["/admin/api/secrets/{key}", "put"],
      ["/admin/api/auth-providers", "post"], ["/admin/api/auth-providers/{id}", "patch"],
      ["/admin/api/system-emails/{slot}", "put"], ["/admin/api/system-emails/{slot}/preview", "post"],
      ["/admin/api/settings/{group}", "patch"], ["/admin/api/settings/mail/test", "post"],
    ];
    for (const [path, method] of routes) {
      const operation = contract.spec.paths[path]![method] as { requestBody?: { content: Record<string, { schema: { required?: string[]; properties?: Record<string, unknown> } }> } };
      const schema = operation.requestBody!.content["application/json"]!.schema;
      expect([Object.keys(schema.properties ?? {}), schema.required], `${method} ${path}`).toEqual([["data"], ["data"]]);
    }
  });

  it("system emails", async () => {
    await contract.expectMatches("/admin/api/system-emails", "/admin/api/system-emails");
    await contract.expectMatches("/admin/api/system-emails/password_reset", "/admin/api/system-emails/{slot}");
    const detail = (await contract.get("/admin/api/system-emails/password_reset")).json().data;
    const templateKeys = contract.declaredKeys({ $ref: "#/components/schemas/SystemEmailsTemplate" }).sort();
    expect(Object.keys(detail.template).sort()).toEqual(templateKeys);
    expect(Object.keys(detail.defaultTemplate).sort()).toEqual(templateKeys);

    const preview = await inject("POST", "/admin/api/system-emails/password_reset/preview", detail.template);
    expect(preview.statusCode, preview.body).toBe(200);
    contract.expectKeys(preview.json().data, contract.dataSchema("/admin/api/system-emails/{slot}/preview", "post"), "preview");

    // A shared setting: write back what is there now, and only reset it when it wasn't overridden before.
    const put = await inject("PUT", "/admin/api/system-emails/password_reset", detail.overridden ? detail.template : detail.defaultTemplate);
    expect(put.statusCode, put.body).toBe(200);
    contract.expectKeys(put.json().data, contract.dataSchema("/admin/api/system-emails/{slot}", "put"), "PUT system email");
    if (!detail.overridden) {
      const reset = await inject("DELETE", "/admin/api/system-emails/password_reset");
      expect(reset.statusCode, reset.body).toBe(200);
      contract.expectKeys(reset.json().data, contract.dataSchema("/admin/api/system-emails/{slot}", "delete"), "DELETE system email");
    }
  });
});
