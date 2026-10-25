import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { MCP_MODES, MCP_TOOL_GROUPS, type McpMode, type McpToolGroup } from "@totalbase/shared";
import { z } from "zod";

/**
 * What an instance lets its agents do through this server
 * (Administration.md §11.7) - Settings > MCP: a mode, the tool
 * groups switched on, and the project's own instructions. It narrows the
 * tools on offer; it never widens anything - every call is still decided
 * by TotalBase's own authorization, as any caller's.
 */
export interface McpPolicy {
  mode: McpMode;
  groups: ReadonlySet<McpToolGroup>;
  /** The project's instructions to every agent, told after the server's own. */
  instructions: string;
}

/** Everything on - what a server built without settings offers (tests, the guides' own check). */
export const FULL_POLICY: McpPolicy = { mode: "FULL", groups: new Set(MCP_TOOL_GROUPS), instructions: "" };

/** The `mcp` settings group's values (keys fully dotted, as GET /admin/api/settings/mcp answers them) as a policy, and whether MCP is on. */
export function policyFromSettings(values: Record<string, unknown>): McpPolicy & { enabled: boolean } {
  const mode = MCP_MODES.includes(values["mcp.mode"] as McpMode) ? (values["mcp.mode"] as McpMode) : "FULL";
  return {
    enabled: values["mcp.enabled"] === true,
    mode,
    groups: new Set(MCP_TOOL_GROUPS.filter((group) => values[`mcp.tools_${group}`] !== false)),
    instructions: typeof values["mcp.instructions"] === "string" ? values["mcp.instructions"].trim() : "",
  };
}

/**
 * Each tool's group - `null` for the ones every agent needs to orient
 * itself (who it is, what exists, the settings, the API's own documents),
 * always on whatever the groups say.
 */
export const TOOL_GROUP: Record<string, McpToolGroup | null> = {
  whoami: null,
  get_settings: null,
  list_resources: null,
  list_roles: null,
  sync_catalog: null,
  list_broken_references: null,
  get_openapi: null,

  describe_table: "schema",
  create_schema: "schema",
  create_table: "schema",
  alter_table: "schema",
  delete_table: "schema",
  expose_resource: "schema",
  set_column_presentation: "schema",
  set_column_presentations: "schema",
  suggest_presentation: "schema",
  set_row_presentation: "schema",

  query_records: "records",
  write_records: "records",
  upload_file: "records",
  call_function: "records",

  grant_permission: "access",
  grant_permissions: "access",
  revoke_permission: "access",
  get_permissions: "access",
  apply_default_permissions: "access",
  set_capability: "access",
  duplicate_role: "access",

  list_users: "users",
  create_user: "users",
  set_user_roles: "users",
  send_user_link: "users",

  list_dataviews: "screens",
  get_dataview: "screens",
  create_dataview: "screens",
  update_dataview: "screens",
  publish_dataview: "screens",
  delete_dataview: "screens",
  get_page: "screens",
  set_page_variables: "screens",
  add_page_widgets: "screens",
  update_page_widget: "screens",
  move_page_widget: "screens",
  delete_page_widget: "screens",
  save_page_code: "screens",
  get_app_menu: "screens",
  check_app: "screens",
  set_app_menu: "screens",

  list_dashboards: "dashboards",
  get_dashboard: "dashboards",
  suggest_dashboard: "dashboards",
  create_dashboard: "dashboards",
  update_dashboard: "dashboards",
  describe_dashboard_widgets: "dashboards",
  preview_query: "dashboards",
  save_widget: "dashboards",
  apply_dashboard: "dashboards",
  delete_widget: "dashboards",
  list_embeds: "dashboards",
  create_embed: "dashboards",
  update_embed: "dashboards",
  revoke_embed: "dashboards",
  publish_dashboard: "dashboards",
  delete_dashboard: "dashboards",

  list_workflows: "workflows",
  list_secrets: "workflows",
  set_secret: "workflows",
  get_workflow: "workflows",
  create_workflow: "workflows",
  save_workflow: "workflows",
  run_workflow: "workflows",
  get_workflow_runs: "workflows",
  publish_workflow: "workflows",
  set_workflow_enabled: "workflows",
  delete_workflow: "workflows",

  list_templates: "templates",
  save_template: "templates",
  test_template: "templates",

  execute_sql: "sql",
  explain_sql: "sql",
};

/** A tool whose whole purpose is to delete or revoke - out of STANDARD mode altogether. */
const REMOVES = /^(delete_|revoke_)/;

/** Whether `policy` offers the tool at all. */
export function offersTool(policy: McpPolicy, name: string, annotations: ToolAnnotations | undefined): boolean {
  const group = TOOL_GROUP[name];
  if (group === undefined) throw new Error(`Tool ${name} has no group in TOOL_GROUP (policy.ts).`);
  if (group !== null && !policy.groups.has(group)) return false;
  if (policy.mode === "READ_ONLY") return annotations?.readOnlyHint === true;
  if (policy.mode === "STANDARD") return !REMOVES.test(name);
  return true;
}

/**
 * The tools a tool body still runs in STANDARD mode but whose destructive
 * branch it refuses: write_records' delete, alter_table's drops,
 * apply_dashboard's deleted widgets, execute_sql's destructive statements.
 */
export function refuseDestructive(policy: McpPolicy, what: string): void {
  if (policy.mode !== "FULL") throw new Error(`${what} - not allowed: this instance runs MCP in ${policy.mode} mode (Settings > MCP). Ask an administrator.`);
}

/** `server`, registering only the tools `policy` offers. */
export function gatedServer(server: McpServer, policy: McpPolicy): McpServer {
  const registerTool = server.registerTool.bind(server) as (name: string, config: { annotations?: ToolAnnotations; inputSchema?: unknown }, callback: unknown) => unknown;
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property === "registerTool") {
        return (name: string, config: { annotations?: ToolAnnotations; inputSchema?: unknown }, callback: unknown) =>
          (offersTool(policy, name, config.annotations) ? registerTool(name, strictArguments(name, config), callback) : undefined);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

/** What the agent is told about the policy it works under, after the server's own orientation. */
export function policyInstructions(policy: McpPolicy): string {
  const parts: string[] = [];
  if (policy.mode === "READ_ONLY") parts.push("This instance runs MCP in READ_ONLY mode: only tools that read are offered - say so to the user when a task needs a change.");
  if (policy.mode === "STANDARD") parts.push("This instance runs MCP in STANDARD mode: nothing can be deleted or revoked through these tools (no delete_* or revoke_permission; write_records delete, alter_table drops, an apply_dashboard spec that leaves widgets out and destructive SQL are refused) - an administrator does that.");
  const off = MCP_TOOL_GROUPS.filter((group) => !policy.groups.has(group));
  if (off.length > 0) parts.push(`Tool groups switched off by its administrators: ${off.join(", ")} - their tools aren't offered.`);
  if (policy.instructions) parts.push(`This project's own instructions, from its administrators - follow them:\n${policy.instructions}`);
  return parts.join("\n\n");
}

/**
 * A tool's arguments, strict (DM5): an argument it doesn't know is refused, naming it and the ones it takes - an
 * agent that sends a wrong one learns so instead of having it dropped. Every tool, through gatedServer.
 */
function strictArguments<T extends { inputSchema?: unknown }>(name: string, config: T): T {
  const shape = config.inputSchema;
  if (!shape || typeof shape !== "object" || shape instanceof z.ZodType) return config;
  const keys = Object.keys(shape);
  const inputSchema = z.strictObject(shape as z.ZodRawShape, {
    error: (issue) => (issue.code === "unrecognized_keys" ? `${name} has no argument ${issue.keys.join(", ")}; it takes: ${keys.join(", ") || "none"}.` : undefined),
  });
  return { ...config, inputSchema };
}
