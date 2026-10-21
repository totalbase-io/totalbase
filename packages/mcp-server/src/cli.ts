#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AdminApiError, AdminClient, loadConfigFromEnv } from "./admin-client.js";
import { policyFromSettings } from "./policy.js";
import { createTotalBaseMcpServer } from "./server.js";

/**
 * TotalBase MCP server over stdio - the transport a local MCP client
 * (Claude Code, Claude Desktop) launches a subprocess with
 * (Administration.md §11.5). TOTALBASE_URL and TOTALBASE_TOKEN
 * (a plane="ADMIN" personal access token) configure it. A remote agent
 * uses the instance's own /mcp instead, served by the TotalBase server.
 *
 * It applies the instance's MCP policy (Settings > MCP) as /mcp does: off,
 * it refuses to start; otherwise its mode, tool groups and instructions.
 */
async function main(): Promise<void> {
  const client = new AdminClient(loadConfigFromEnv());
  let settings: Record<string, unknown>;
  try {
    settings = await client.get<Record<string, unknown>>("/settings/mcp");
  } catch (error) {
    throw new Error(error instanceof AdminApiError ? `Could not read Settings > MCP: ${error.message}` : String(error));
  }
  const policy = policyFromSettings(settings);
  if (!policy.enabled) throw new Error("MCP is off on this instance - an administrator turns it on in Settings > MCP.");

  const server = createTotalBaseMcpServer(client, policy);
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
   
  console.error("[totalbase-mcp] fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
