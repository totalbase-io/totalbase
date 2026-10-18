/**
 * The MCP server's policy vocabulary (Specification_Administration.md §11.7):
 * read by the settings registry (Settings > MCP), the server that serves
 * /mcp, and the MCP package that filters its tools by it.
 */

/** READ_ONLY: only tools that read. STANDARD: every tool but those that delete or revoke - a destructive call is refused. FULL: everything, destructive calls behind confirm=true. */
export const MCP_MODES = ["READ_ONLY", "STANDARD", "FULL"] as const;
export type McpMode = (typeof MCP_MODES)[number];

/** The areas tools are switched on or off by - each a `mcp.tools_<group>` setting. */
export const MCP_TOOL_GROUPS = ["schema", "records", "access", "users", "screens", "dashboards", "workflows", "templates", "sql"] as const;
export type McpToolGroup = (typeof MCP_TOOL_GROUPS)[number];

/** How long a project's instructions to the agent may be. */
export const MCP_INSTRUCTIONS_MAX = 8000;
