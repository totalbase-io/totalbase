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
 * branch it refuses: write_records' delete and revoked_at, alter_table's drops,
 * apply_dashboard's deleted widgets, update_dataview's remove_columns,
 * set_capability OFF, a role set that drops a role (refuseRemovedRoles),
 * execute_sql's destructive statements.
 */
export function refuseDestructive(policy: McpPolicy, what: string): void {
  if (policy.mode !== "FULL") throw new Error(`${what} - not allowed: this instance runs MCP in ${policy.mode} mode (Settings > MCP). Ask an administrator.`);
}

/** Workflow steps that delete, or run SQL no guard reads (Workflows.md §5) - out of STANDARD runs and drafts. */
const DESTRUCTIVE_OPERATIONS = new Set(["totalbase.delete-records", "totalbase.execute-sql"]);

type WorkflowStep = { type: string; configuration?: Record<string, unknown> | undefined };

/** What refuseDestructiveWorkflow reads: a called workflow's live steps, and a step's resource by id. */
export interface WorkflowLookups {
  publishedOf(workflowId: string): Promise<readonly WorkflowStep[]>;
  resourceOf(resourceId: string): Promise<{ schema: string; name: string }>;
}

/**
 * A workflow an agent saves, runs, publishes or turns on under STANDARD mode: refused when a step of it deletes or
 * runs raw SQL, when a Create or Update records step writes what write_records refuses (a revoke - refuseRevokingCreate,
 * refuseRevokingUpdate), or when a workflow it calls (Execute workflow, its published version, through every level)
 * does. Otherwise save_workflow then run_workflow would do what write_records and execute_sql refuse. What can't be
 * read - a called workflow, a step's resource - refuses too, since nothing then shows it takes nothing away; so do
 * a step's records or values given as one binding, which can't be checked before the run.
 */
export async function refuseDestructiveWorkflow(policy: McpPolicy, what: string, operations: readonly WorkflowStep[], lookups: WorkflowLookups, seen: Set<string> = new Set()): Promise<void> {
  if (policy.mode === "FULL") return;
  for (const op of operations) {
    if (DESTRUCTIVE_OPERATIONS.has(op.type)) refuseDestructive(policy, `${what}: a ${op.type} step deletes data or runs raw SQL`);
    const configuration = op.configuration ?? {};
    if (op.type === "totalbase.create-records" || op.type === "totalbase.update-records") {
      const resourceId = configuration["resource"];
      let resource: { schema: string; name: string };
      try {
        if (typeof resourceId !== "string") throw new Error("no resource");
        resource = await lookups.resourceOf(resourceId);
      } catch {
        return refuseDestructive(policy, `${what}: a ${op.type} step's resource couldn't be read to check it revokes nothing`);
      }
      const objects = (value: unknown): Record<string, unknown>[] | null =>
        Array.isArray(value) ? (value.every((row) => typeof row === "object" && row !== null && !Array.isArray(row)) ? (value as Record<string, unknown>[]) : null)
          : typeof value === "object" && value !== null ? [value as Record<string, unknown>] : null;
      const step = `${what}: a ${op.type} step on ${resource.schema}.${resource.name}`;
      // A value that is a binding ({{...}}) is known only at run time - a DENY, a role, a revoke can come in it.
      if (resource.schema === "totalbase" && JSON.stringify(configuration[op.type === "totalbase.create-records" ? "records" : "set"] ?? null).includes("{{")) {
        refuseDestructive(policy, `${step} takes a value from a binding - it can't be checked before the run`);
      }
      if (op.type === "totalbase.create-records") {
        const rows = objects(configuration["records"] ?? []);
        if (!rows) {
          if (resource.schema === "totalbase") refuseDestructive(policy, `${step} writes records given as one binding - they can't be checked before the run`);
        } else refuseRevokingCreate(policy, resource.schema, resource.name, rows);
      } else {
        const set = objects(configuration["set"] ?? {});
        if (!set) {
          if (resource.schema === "totalbase") refuseDestructive(policy, `${step} sets values given as one binding - they can't be checked before the run`);
        } else refuseRevokingUpdate(policy, resource.schema, resource.name, set[0]!);
      }
    }
    const called = op.type === "totalbase.execute-workflow" ? configuration["workflow"] : undefined;
    if (op.type === "totalbase.execute-workflow" && typeof called !== "string") refuseDestructive(policy, `${what}: an Execute workflow step whose workflow is a binding can't be checked before the run`);
    if (typeof called !== "string" || seen.has(called)) continue;
    seen.add(called);
    let steps: readonly WorkflowStep[];
    try {
      steps = await lookups.publishedOf(called);
    } catch {
      return refuseDestructive(policy, `${what}: the workflow it calls (${called}) couldn't be read to check it deletes nothing`);
    }
    await refuseDestructiveWorkflow(policy, what, steps, lookups, seen);
  }
}

/**
 * A role set about to be replaced (who may open a screen, run a workflow, the roles a user holds) under STANDARD
 * mode: refused when it would take away a role that has it now - a removal like any other. `current` reads the
 * roles that have it; one that can't be read refuses too, since nothing then shows the new set keeps them.
 */
export async function refuseRemovedRoles(policy: McpPolicy, what: string, next: readonly string[], current: () => Promise<readonly string[]>): Promise<void> {
  if (policy.mode === "FULL") return;
  let held: readonly string[];
  try {
    held = await current();
  } catch {
    return refuseDestructive(policy, `${what} (the current set couldn't be read to check none is removed)`);
  }
  const removed = held.filter((role) => !next.includes(role));
  if (removed.length > 0) refuseDestructive(policy, `${what} removes ${removed.length === 1 ? "a role" : `${removed.length} roles`} (${removed.join(", ")})`);
}

/** The columns of TotalBase's tables whose change revokes - a credential ended, an assignment or a grant moved. */
const REVOKING_COLUMNS: Record<string, readonly string[]> = {
  users: ["active", "can_login", "locked_until"],
  tokens: ["active", "expires_at", "revoked_at"],
  sessions: ["expires_at", "revoked_at"],
  roles: ["active", "parent", "admin_access", "app_access", "api_access"],
  // A grant changed in place may narrow or deny what it gave: any change of one is out of STANDARD (grant_permission
  // writes an ALLOW grant whole, and refuses a DENY).
  permissions: ["role", "resource", "action", "effect", "where_clause", "field_overrides", "payload_checks"],
  users_roles: ["user", "role", "expires_at"],
  dataviews_roles: ["dataview", "role"],
  dashboards_roles: ["dashboard", "role"],
  workflows_roles: ["workflow", "role"],
  roles_managers: ["role", "manager"],
  roles_capabilities: ["role", "capability", "effect"],
};

/**
 * A Data API create under STANDARD mode: refused when the row it adds takes something away - a DENY (a grant's, a
 * capability's), whatever ALLOW another role has.
 */
export function refuseRevokingCreate(policy: McpPolicy, schema: string, table: string, rows: Record<string, unknown>[]): void {
  if (policy.mode === "FULL" || schema !== "totalbase") return;
  const denies = (row: Record<string, unknown>) =>
    row["effect"] === "DENY" || (Array.isArray(row["field_overrides"]) && row["field_overrides"].some((field) => (field as { effect?: unknown } | null)?.effect === "DENY"));
  if ((table === "roles_capabilities" || table === "permissions") && rows.some(denies)) refuseDestructive(policy, "A DENY (it revokes)");
  // A nested create's child rows (`$<child_table>`, Data_API.md §6) are rows of that table too.
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (key.startsWith("$") && Array.isArray(value)) refuseRevokingCreate(policy, schema, key.slice(1), value as Record<string, unknown>[]);
    }
  }
}

/**
 * A Data API update (a PATCH's data, an upsert's DO UPDATE) under STANDARD mode: refused when it would revoke - a
 * `revoked_at` anywhere, or a column of TotalBase's own whose change ends a credential or moves an assignment.
 */
/** TotalBase's tables whose every change touches who gets in or what is reached - out of STANDARD for any update. */
const ACCESS_TABLES = new Set(["providers", "identities", "resources", "menus"]);

export function refuseRevokingUpdate(policy: McpPolicy, schema: string, table: string, data: Record<string, unknown>): void {
  if (policy.mode === "FULL") return;
  if (data["revoked_at"] != null) refuseDestructive(policy, "Revoking (revoked_at)");
  if (schema === "totalbase" && ACCESS_TABLES.has(table)) refuseDestructive(policy, `Changing ${table} (it decides who gets in or what is reached)`);
  const columns = schema === "totalbase" ? REVOKING_COLUMNS[table] : undefined;
  const touched = columns?.filter((column) => column in data) ?? [];
  if (touched.length > 0) refuseDestructive(policy, `Changing ${touched.join(", ")} of ${table} (it ends or moves access)`);
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
  if (policy.mode === "STANDARD") parts.push("This instance runs MCP in STANDARD mode: nothing can be deleted or revoked through these tools (no delete_* or revoke_permission; write_records delete or a revoked_at, alter_table drops, an apply_dashboard spec that leaves widgets out, update_dataview remove_columns, set_capability OFF, a role set that drops a role, a DENY, a change that ends a token or moves an assignment, destructive SQL, and saving, running, publishing or turning on a workflow with a Delete records or Execute SQL step, or a Create/Update records step that revokes - its own or one it calls - are refused) - an administrator does that. execute_sql runs one statement read-only and rolls it back: query freely, but views, functions and triggers need FULL mode.");
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
