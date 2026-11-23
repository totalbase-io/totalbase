import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MCP_TOOL_GROUPS } from "@totalbase/shared";
import { describe, expect, it, vi } from "vitest";
import { AdminClient } from "./admin-client.js";
import { FULL_POLICY, policyFromSettings, type McpPolicy } from "./policy.js";
import { createTotalBaseMcpServer } from "./server.js";

/** A server under `policy`, connected to a client - no instance behind it: nothing here reaches one. */
async function connect(policy: McpPolicy) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
  const server = createTotalBaseMcpServer(new AdminClient({ baseUrl: "http://localhost:0", token: "unused", fetch: fetchMock }), policy);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "policy-test", version: "1.0.0" });
  await client.connect(clientTransport);
  return { client, fetchMock, tools: (await client.listTools()).tools };
}

describe("MCP policy", () => {
  it("reads Settings > MCP: off by default, every group on unless switched off", () => {
    expect(policyFromSettings({})).toMatchObject({ enabled: false, mode: "FULL" });
    const policy = policyFromSettings({ "mcp.enabled": true, "mcp.mode": "STANDARD", "mcp.tools_sql": false, "mcp.instructions": "  Use Spanish names.  " });
    expect(policy).toMatchObject({ enabled: true, mode: "STANDARD", instructions: "Use Spanish names." });
    expect([...policy.groups]).toEqual(MCP_TOOL_GROUPS.filter((g) => g !== "sql"));
  });

  it("declares an output schema on every tool - an object, so a client can write code against the answers", async () => {
    const { tools } = await connect(FULL_POLICY);
    expect(tools.filter((t) => t.outputSchema?.type !== "object").map((t) => t.name)).toEqual([]);
  });

  it("offers only tools that read in READ_ONLY mode", async () => {
    const { tools } = await connect({ ...FULL_POLICY, mode: "READ_ONLY" });
    expect(tools.length).toBeGreaterThan(10);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.map((t) => t.name)).toContain("describe_table");
    expect(tools.map((t) => t.name)).not.toContain("write_records");
  });

  it("drops what deletes or revokes in STANDARD mode, and refuses a destructive call", async () => {
    const { client, tools, fetchMock } = await connect({ ...FULL_POLICY, mode: "STANDARD" });
    const names = tools.map((t) => t.name);
    expect(names.filter((n) => /^(delete_|revoke_)/.test(n))).toEqual([]);
    expect(names).toContain("write_records");
    const answer = await client.callTool({ name: "write_records", arguments: { name: "orders", operation: "delete", id: "1", confirm: true } });
    expect(answer.isError).toBe(true);
    expect(JSON.stringify(answer.content)).toMatch(/STANDARD mode/);
    expect(fetchMock).not.toHaveBeenCalled();
    const sql = await client.callTool({ name: "execute_sql", arguments: { sql: "DROP TABLE orders", confirm: true } });
    expect(JSON.stringify(sql.content)).toMatch(/STANDARD mode/);
  });

  // Security regression (SEC-103, round 8): STANDARD refused execute_sql's writes and write_records' delete and revokes,
  // but an agent could save, run, publish or turn on a workflow whose steps did them - an Execute SQL or Delete records
  // step, a Create/Update records step revoking access (a token's revoked_at, a DENY grant), or a workflow it calls.
  it("refuses a workflow that deletes, runs raw SQL or revokes - saving, running, publishing or turning it on - in STANDARD mode (SEC-103)", async () => {
    const { client, fetchMock } = await connect({ ...FULL_POLICY, mode: "STANDARD" });
    const answer = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
    const start = { key: "start", type: "totalbase.start", configuration: { trigger: "MANUAL" } };
    const LIVE = "0c4d5e6f-0000-4000-8000-000000000001";
    let draft: unknown[] = [start];
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      const path = String(args[0]);
      if (path.includes("/workflows/w2/versions/3")) return answer({ definition: { operations: [{ type: "totalbase.delete-records", configuration: {} }], connections: [] } });
      if (path.endsWith("/workflows/w2")) return answer({ id: "w2", publishedVersion: LIVE, liveVersion: 3 });
      if (path.includes("/workflows/w1/draft")) return answer({ definition: { operations: draft, connections: [] } });
      if (path.includes("/resources")) return answer([{ schema: "totalbase", name: path.includes("tokens-id") ? "tokens" : "permissions" }]);
      return answer([]);
    });
    const save = (operations: unknown[]) => client.callTool({ name: "save_workflow", arguments: { id: "w1", revision: "1", operations: [start, ...operations] } });
    const refused = async (call: Promise<Record<string, unknown>>, pattern: RegExp) => {
      const out = await call;
      expect([out["isError"], JSON.stringify(out["content"])]).toEqual([true, expect.stringMatching(pattern)]);
    };

    await refused(save([{ key: "sql", type: "totalbase.execute-sql", configuration: { statement: "DROP TABLE orders" } }]), /execute-sql.*STANDARD mode/);
    await refused(save([{ key: "call", type: "totalbase.execute-workflow", configuration: { workflow: "w2" } }]), /delete-records.*STANDARD mode/);
    await refused(save([{ key: "rev", type: "totalbase.update-records", configuration: { resource: "tokens-id", set: { revoked_at: "now" } } }]), /revoked_at.*STANDARD mode/);
    await refused(save([{ key: "deny", type: "totalbase.create-records", configuration: { resource: "perm-id", records: [{ role: "r", effect: "DENY" }] } }]), /DENY.*STANDARD mode/);
    await refused(save([{ key: "bound", type: "totalbase.create-records", configuration: { resource: "perm-id", records: "{{start.data.rows}}" } }]), /binding.*STANDARD mode/);
    // Round 9: a value that is a binding inside a literal row - the DENY comes in at run time.
    await refused(save([{ key: "tpl", type: "totalbase.create-records", configuration: { resource: "perm-id", records: [{ role: "r", effect: "{{start.data.e}}" }] } }]), /binding.*STANDARD mode/);
    expect((fetchMock.mock.calls as unknown[][]).some((call) => String(call[0]).endsWith("/workflows/w1/draft") && (call[1] as RequestInit | undefined)?.method === "PUT")).toBe(false);

    // A draft a person wrote, with a delete step: not run, not published.
    draft = [start, { type: "totalbase.delete-records", configuration: {} }];
    await refused(client.callTool({ name: "run_workflow", arguments: { id: "w1", mode: "test" } }), /delete-records.*STANDARD mode/);
    await refused(client.callTool({ name: "publish_workflow", arguments: { id: "w1", revision: "1" } }), /delete-records.*STANDARD mode/);
    // A live version read by its number - and one that deletes is not turned on.
    await refused(client.callTool({ name: "set_workflow_enabled", arguments: { id: "w2", enabled: true } }), /delete-records.*STANDARD mode/);
    expect((fetchMock.mock.calls as unknown[][]).every((call) => !/test-run|\/publish$/.test(String(call[0])))).toBe(true);

    // FULL mode saves it.
    const full = await connect(FULL_POLICY);
    full.fetchMock.mockImplementation(async () => answer({ workflow: { id: "w1", name: "w", slug: "w", description: null, revision: "2", enabled: false, liveVersion: 0, hasUnpublishedChanges: true }, definition: { operations: [], connections: [] } }));
    const allowed = await full.client.callTool({ name: "save_workflow", arguments: { id: "w1", revision: "1", operations: [start, { key: "sql", type: "totalbase.execute-sql", configuration: { statement: "SELECT 1" } }] } });
    expect(allowed.isError, JSON.stringify(allowed.content)).toBeFalsy();
  });

  it("runs execute_sql read-only in STANDARD mode and as written in FULL (SEC-88)", async () => {
    const sent = async (mode: "STANDARD" | "FULL") => {
      const { client, fetchMock } = await connect({ ...FULL_POLICY, mode });
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ data: { status: "EXECUTED", statements: [] } }), { status: 200 }));
      const answer = await client.callTool({ name: "execute_sql", arguments: { sql: "SELECT public.purge()", transactional: true } });
      expect(answer.isError, JSON.stringify(answer.content)).toBeFalsy();
      return (JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as { data: Record<string, unknown> }).data;
    };
    expect(await sent("STANDARD")).toEqual({ sql: "SELECT public.purge()", readOnly: true });
    expect(await sent("FULL")).toEqual({ sql: "SELECT public.purge()", transactional: true });
  });

  it("refuses in STANDARD mode an apply_dashboard that would delete widgets, and applies one against the draft its check saw", async () => {
    const answers: unknown[] = [];
    const { client, fetchMock } = await connect({ ...FULL_POLICY, mode: "STANDARD" });
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ data: answers.shift() }), { status: 200 }));
    const spec = { name: "Sales", variables: [], tabs: [], widgets: [] };

    answers.push({ draftVersion: "v1", diff: { widgets: { deleted: [{ label: "Revenue", type: "KPI" }] } } });
    const refused = await client.callTool({ name: "apply_dashboard", arguments: { id: "d1", spec } });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toMatch(/Deleting widgets \(Revenue\).*STANDARD mode/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    answers.push({ draftVersion: "v2", diff: { widgets: { deleted: [] } } }, { applied: true });
    const applied = await client.callTool({ name: "apply_dashboard", arguments: { id: "d1", spec } });
    expect(applied.isError, JSON.stringify(applied.content)).toBeFalsy();
    const body = (call: number) => JSON.parse(String((fetchMock.mock.calls[call] as unknown as [string, RequestInit])[1].body)) as { data: Record<string, unknown> };
    expect(body(1).data.dryRun).toBe(true);
    expect(body(2).data).toMatchObject({ draftVersion: "v2" });
    expect(body(2).data.dryRun).toBeUndefined();
  });

  // Security regression (Administration.md §11.7): STANDARD's "nothing deleted or revoked" held only for tools named
  // delete_*/revoke_* and a few branches - set_capability OFF deleted a grant, update_dataview remove_columns deleted
  // fields, a role set left roles out, and write_records revoked sessions and tokens through revoked_at.
  it("refuses every removal in STANDARD mode, whichever tool makes it", async () => {
    const { client, fetchMock } = await connect({ ...FULL_POLICY, mode: "STANDARD" });
    const writes: string[] = [];
    fetchMock.mockImplementation((async (url: URL, init: RequestInit) => {
      const method = init.method ?? "GET";
      if (method !== "GET") writes.push(`${method} ${url.pathname}`);
      if (url.pathname.endsWith("/users_roles")) return new Response(JSON.stringify({ data: [{ role: "r1" }, { role: "r2" }] }), { status: 200 });
      if (url.pathname.endsWith("/roles_capabilities")) return new Response(JSON.stringify({ data: [{ id: "c1" }] }), { status: 200 });
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }) as never);
    const refused = async (name: string, args: Record<string, unknown>) => {
      const answer = await client.callTool({ name, arguments: args });
      expect(answer.isError, name).toBe(true);
      expect(JSON.stringify(answer.content), name).toMatch(/STANDARD mode/);
    };
    await refused("set_user_roles", { user_id: "u1", role_ids: ["r1"] });
    await refused("set_capability", { role_id: "r1", capability: "MANAGE_ROLES", effect: "OFF" });
    await refused("update_dataview", { id: "d1", remove_columns: ["price"] });
    await refused("write_records", { name: "sessions", schema: "totalbase", operation: "update", id: "s1", data: { revoked_at: "2026-11-18T00:00:00Z" } });
    // SEC-87: ending a token another way, an upsert's revoke, moving an assignment, a DENY.
    await refused("write_records", { name: "tokens", schema: "totalbase", operation: "update", id: "t1", data: { active: false } });
    await refused("write_records", { name: "tokens", schema: "totalbase", operation: "update", id: "t1", data: { expires_at: "2000-01-01T00:00:00Z" } });
    await refused("write_records", { name: "tokens", schema: "totalbase", operation: "create", data: { id: "t1", name: "x" }, on_conflict: { target: ["id"], action: "UPDATE", data: { revoked_at: "2026-11-18T00:00:00Z" } } });
    await refused("write_records", { name: "users_roles", schema: "totalbase", operation: "update", id: "a1", data: { role: "r9" } });
    await refused("grant_permission", { role_id: "r1", schema: "public", name: "orders", action: "READ", effect: "DENY" });
    await refused("set_capability", { role_id: "r1", capability: "MANAGE_ROLES", effect: "DENY" });
    // SEC-92: the same through write_records - a DENY row created, a user deactivated.
    await refused("write_records", { name: "roles_capabilities", schema: "totalbase", operation: "create", data: { role: "r1", capability: "MANAGE_ROLES", effect: "DENY" } });
    await refused("write_records", { name: "users", schema: "totalbase", operation: "update", id: "u1", data: { active: false } });
    // SEC-96: an assignment ended by its expiry, a role switched off, a grant changed in place, a created grant's DENY field.
    await refused("write_records", { name: "users_roles", schema: "totalbase", operation: "update", id: "a1", data: { expires_at: "2000-01-01T00:00:00Z" } });
    await refused("write_records", { name: "roles", schema: "totalbase", operation: "update", id: "r1", data: { active: false } });
    await refused("write_records", { name: "permissions", schema: "totalbase", operation: "update", id: "p1", data: { field_overrides: [{ field: "price", effect: "DENY" }] } });
    await refused("write_records", { name: "workflows_roles", schema: "totalbase", operation: "update", id: "w1", data: { role: "r2" } });
    await refused("write_records", { name: "permissions", schema: "totalbase", operation: "create", data: { role: "r1", resource: "x", action: "READ", effect: "ALLOW", field_overrides: [{ field: "price", effect: "DENY" }] } });
    // SEC-99/100: a DENY nested under a create; an access table changed; an embed ended; a method unexposed.
    await refused("write_records", { name: "roles", schema: "totalbase", operation: "create", data: { name: "x", $permissions: [{ resource: "x", action: "READ", effect: "DENY" }] } });
    await refused("write_records", { name: "providers", schema: "totalbase", operation: "update", id: "p1", data: { enabled: false } });
    await refused("update_embed", { dashboard_id: "d1", embed_id: "e1", expires_at: "2000-01-01T00:00:00Z" });
    expect(writes).toEqual([]);

    // Adding keeps every role that has it: allowed.
    const added = await client.callTool({ name: "set_user_roles", arguments: { user_id: "u1", role_ids: ["r1", "r2", "r3"] } });
    expect(added.isError, JSON.stringify(added.content)).toBeFalsy();
    expect(writes).toEqual(["PUT /admin/api/users/u1/roles"]);
  });

  it("leaves a switched-off group's tools out, the orienting ones in", async () => {
    const { tools } = await connect({ ...FULL_POLICY, groups: new Set(MCP_TOOL_GROUPS.filter((g) => g !== "workflows" && g !== "sql")) });
    const names = tools.map((t) => t.name);
    expect(names.some((n) => n.includes("workflow"))).toBe(false);
    expect(names).not.toContain("execute_sql");
    expect(names).toEqual(expect.arrayContaining(["whoami", "list_resources", "get_openapi"]));
  });

  it("tells the agent the policy and the project's instructions", async () => {
    const { client } = await connect({ mode: "STANDARD", groups: new Set(["records"]), instructions: "Name tables in Spanish." });
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toMatch(/STANDARD mode/);
    expect(instructions).toMatch(/switched off.*schema/);
    expect(instructions).toMatch(/Name tables in Spanish\./);
  });
});
