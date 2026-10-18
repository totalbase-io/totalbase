/**
 * @totalbase/mcp-server's public surface: the tools and the Admin API client,
 * for whoever builds an MCP server around them (apps/server's /mcp, cli.ts - the
 * `totalbase-mcp` stdio binary - and tests). Importing it starts nothing.
 */
export * from "./admin-client.js";
export * from "./tools.js";
export * from "./server.js";
export { INSTRUCTIONS } from "./guides.js";
export * from "./policy.js";
export { serveMcpRequest } from "./http.js";
