import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Database } from "@totalbase/database";
import type { SettingKey } from "@totalbase/settings";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { setupTestApp } from "./test-support.js";

/**
 * POST /mcp, served by the TotalBase server itself (Administration.md
 * §11.5, §11.7): off until an administrator turns it on, authenticated as
 * the Admin API, narrowed by Settings > MCP, its tools' calls injected
 * in-process and audited as the caller's.
 */
describe("MCP endpoint (POST /mcp)", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let baseUrl: string;
  let token: string;
  let userId: string;
  const SUFFIX = randomBytes(3).toString("hex");
  const SCHEMA = `mcp_endpoint_${SUFFIX}`;
  const TOUCHED: SettingKey[] = ["mcp.enabled", "mcp.mode", "mcp.instructions", "mcp.rate_limit_per_minute", "mcp.allowed_hosts"];
  const saved = new Map<SettingKey, { overridden: boolean; value: unknown }>();

  async function connect(): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    const client = new Client({ name: "mcp-endpoint-test", version: "1.0.0" });
    // The transport's sessionId is typed `string | undefined`, which exactOptionalPropertyTypes holds incompatible with Transport's.
    await client.connect(transport as unknown as Transport);
    return client;
  }
  const listTools = (headers: Record<string, string> = {}, bearer = token) =>
    app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await app.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    for (const key of TOUCHED) saved.set(key, { overridden: await context.settings.isOverridden(key), value: await context.settings.get(key) });
    const user = await context.auth.users.create({ email: `mcp-endpoint-${SUFFIX}@example.com`, name: "MCP endpoint" });
    userId = user.id;
    await context.roleAssignments.assignRoleToUser(user.id, await context.roles.getAdministratorsRoleId());
    token = (await context.usersApis.create({ userId: user.id, name: `mcp-endpoint-${SUFFIX}`, plane: "ADMIN" })).plainKey;
  });

  afterAll(async () => {
    for (const [key, { overridden, value }] of saved) {
      if (overridden) await context.settings.set(key, value as never);
      else await context.settings.reset(key);
    }
    await database.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [userId]);
    await app.close();
  });

  it("doesn't answer while MCP is off", async () => {
    await context.settings.set("mcp.enabled", false);
    const response = await listTools();
    expect([response.statusCode, response.json().errors[0].code]).toEqual([404, "RESOURCE_NOT_FOUND"]);
  });

  it("serves the tools to an administrator's token, its calls audited as theirs", async () => {
    await context.settings.set("mcp.enabled", true);
    await context.settings.set("mcp.mode", "FULL");
    expect((await app.inject({ method: "POST", url: "/mcp", payload: {} })).statusCode).toBe(401);

    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["whoami", "create_table", "delete_table"]));
    const me = await client.callTool({ name: "whoami", arguments: {} });
    expect(JSON.parse((me.content as { text: string }[])[0]!.text)).toMatchObject({ id: userId });

    await client.callTool({ name: "create_schema", arguments: { name: SCHEMA } });
    const { rows } = await database.query<{ user_agent: string }>(
      `SELECT user_agent FROM totalbase.logs WHERE principal = $1 AND action = 'DDL' AND created_at > now() - interval '1 minute' ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    expect(rows[0]?.user_agent).toMatch(/^TotalBase MCP/);
    await client.close();
  });

  // B43: the tools' requests are injected in-process - a file's content (upload_file's multipart) goes through too.
  it("uploads a file through the endpoint - its multipart body injected whole", async () => {
    await context.settings.set("mcp.enabled", true);
    await context.settings.set("mcp.mode", "FULL");
    const client = await connect();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>';
    const answer = await client.callTool({ name: "upload_file", arguments: { name: `b43-${SUFFIX}.svg`, mime_type: "image/svg+xml", text: svg, visibility: "PUBLIC" } });
    const text = (answer.content as { text: string }[])[0]!.text;
    expect(answer.isError, text).toBeFalsy();
    const file = JSON.parse(text) as { id: string; name: string; visibility: string };
    try {
      expect([file.name, file.visibility]).toEqual([`b43-${SUFFIX}.svg`, "PUBLIC"]);
      const content = await app.inject({ method: "GET", url: `/api/totalbase/table/files/${file.id}` });
      expect([content.statusCode, content.body]).toEqual([200, svg]);
    } finally {
      await database.query(`DELETE FROM totalbase.files WHERE id = $1`, [file.id]);
      await client.close();
    }
  });

  it("narrows the tools by the mode and tells the project's instructions", async () => {
    await context.settings.set("mcp.mode", "READ_ONLY");
    await context.settings.set("mcp.instructions", "Name every table in Spanish.");
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    expect(client.getInstructions()).toMatch(/READ_ONLY mode[\s\S]*Name every table in Spanish\./);
    await client.close();
    await context.settings.set("mcp.mode", "FULL");
  });

  it("refuses a Host it doesn't know - unless it is listed", async () => {
    const foreign = await listTools({ host: "attacker.example" });
    expect([foreign.statusCode, foreign.json().errors[0].code]).toEqual([403, "PERMISSION_DENIED"]);
    await context.settings.set("mcp.allowed_hosts", ["attacker.example"]);
    expect((await listTools({ host: "attacker.example" })).statusCode).toBe(200);
    await context.settings.reset("mcp.allowed_hosts");
  });

  it("limits each token's requests per minute", async () => {
    await context.settings.set("mcp.rate_limit_per_minute", 2);
    // A token of its own: the others already spent this minute's window.
    const fresh = (await context.usersApis.create({ userId, name: `mcp-endpoint-limit-${SUFFIX}`, plane: "ADMIN" })).plainKey;
    const responses = [];
    for (let i = 0; i < 3; i += 1) responses.push(await listTools({}, fresh));
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 429]);
    // When to try again: the seconds left in the window.
    expect(Number(responses[2]!.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    await context.settings.reset("mcp.rate_limit_per_minute");
  });

  it("never lets a token change its own MCP policy", async () => {
    const response = await app.inject({ method: "PATCH", url: "/admin/api/settings/mcp", headers: { authorization: `Bearer ${token}` }, payload: { data: { mode: "FULL" } } });
    expect([response.statusCode, response.json().errors[0].code]).toEqual([403, "PERMISSION_DENIED"]);
  });
});
