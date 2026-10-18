import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AdminClient } from "./admin-client.js";
import type { McpPolicy } from "./policy.js";
import { createTotalBaseMcpServer } from "./server.js";

/**
 * Answers one MCP request over HTTP (Specification_Administration.md
 * §11.5) - what the TotalBase server's POST /mcp hands over once it has
 * authenticated the caller and read the policy. Stateless: a fresh server
 * and transport per request, closed with its response, so nothing is shared
 * between callers or requests.
 */
export async function serveMcpRequest(request: IncomingMessage, response: ServerResponse, body: unknown, client: AdminClient, policy: McpPolicy): Promise<void> {
  const server = createTotalBaseMcpServer(client, policy);
  // Omitting sessionIdGenerator (rather than setting it to undefined) is the
  // SDK's stateless mode - exactOptionalPropertyTypes rejects the latter.
  const transport = new StreamableHTTPServerTransport({});
  response.on("close", () => {
    void transport.close();
    void server.close();
  });
  // The transport's onclose/onerror getters are typed `(() => void) | undefined`, which
  // exactOptionalPropertyTypes holds incompatible with Transport's setters - a type-level SDK quirk.
  await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
  await transport.handleRequest(request, response, body);
}
