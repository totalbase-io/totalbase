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
