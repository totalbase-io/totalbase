import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AdminClient } from "./admin-client.js";
import { INSTRUCTIONS, registerGuides } from "./guides.js";
import { FULL_POLICY, gatedServer, policyInstructions, type McpPolicy } from "./policy.js";
import { registerTools } from "./tools.js";

/**
 * The TotalBase MCP server over one Admin API client: its tools, its
 * orientation and its guides - the same for every transport - narrowed by
 * the instance's policy (Settings > MCP): only the tools it offers are
 * registered, and the agent is told the policy and the project's own
 * instructions.
 */
export function createTotalBaseMcpServer(client: AdminClient, policy: McpPolicy = FULL_POLICY): McpServer {
  const told = policyInstructions(policy);
  const server = new McpServer({ name: "totalbase", version: "0.1.0" }, { instructions: told ? `${INSTRUCTIONS}\n\n${told}` : INSTRUCTIONS });
  registerTools(gatedServer(server, policy), client, policy);
  registerGuides(server, client);
  return server;
}
