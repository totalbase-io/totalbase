import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { whereParams, type AdminClient } from "./admin-client.js";
import { pagesGuide, widgetsGuide } from "./guides-pages.js";
import { BUILD, DATA_API, DATAVIEWS, dashboardsGuide, ERRORS, FILES, INSTRUCTIONS, MODELING, PERMISSIONS, WORKFLOWS } from "./guides-text.js";
import { PDF_TEMPLATES } from "./guides-pdf.js";
import { RESOURCES, type ResourceRow } from "./tool-helpers.js";
import { operationMenu } from "@totalbase/tb-catalog";
import { describeShape } from "@totalbase/shared";

/**
 * What the agent is told about TotalBase besides the tools
 * (Administration.md §11.4): an orientation in the server's
 * `instructions`, and read-only guides as MCP resources. Two read the
 * instance itself when opened - which of TotalBase's own tables this
 * instance exposes, and which workflow operation types it can publish - so
 * they describe this instance, not an idea of it.
 */

export { INSTRUCTIONS };

/** What each of TotalBase's own tables is for, who writes it and how (Security.md §10). */
const TOTALBASE_TABLES: Record<string, string> = {
  users: "Accounts. Create with create_user (a password or an invitation), roles with set_user_roles; rename, deactivate (active=false) or set the developer's own columns with write_records. email, can_login and lock state are administrator-only; owner never changes.",
  roles: "Roles: name, description, icon, color, active, app_access, api_access (write_records). admin_access and reserved are TotalBase's (leave them out, or false).",
  users_roles: "A user's roles, one row {user, role} each. Add or remove one with write_records; replace the set with set_user_roles.",
  permissions: "Grants - read here, written only through grant_permission / revoke_permission (their filters are validated).",
  roles_capabilities: "Capabilities per role (TRANSACTIONS, SEND_EMAIL) - set_capability.",
  resources: "TotalBase's registry of tables, views and functions - list_resources; changed through expose_resource.",
  files: "File metadata (name, mime_type, size_bytes, width, height, folder, tags, visibility). Its content comes in with upload_file (base64 or text); query_records reads it as files, write_records updates or deletes it (by id) - the Data API's path is /api/totalbase/table/files.",
  folders: "Folders {name, parent} for files - write_records.",
  templates: "Email (MAILING) and PDF templates - designed in the admin; read here, used by workflows.",
  logs: "The audit log - who did what, when (every write, sign-in and admin change; reads of a table with audit_read). Read it with query_records, e.g. order_by -created_at.",
  sessions: "Signed-in sessions - read, or revoked (revoked_at).",
  tokens: "Personal access tokens - read, rename, deactivate; issued from the admin.",
  dataviews_roles: "Who may open each DataView - set by publish_dataview role_ids.",
  dashboards_roles: "Who may view each dashboard - set by publish_dashboard role_ids.",
  roles_managers: "Which roles may assign which: a row {role, manager} lets the manager role's members assign role (delegated administration, totalbase://guide/permissions). Administrator-written.",
  menus: "The App menu tree - published DataViews and dashboards join it by themselves.",
  roles_reviews: "Periodic access reviews - an administrator's attestation.",
};

async function totalbaseTablesGuide(client: AdminClient): Promise<string> {
  const resources = await client.data<ResourceRow[]>("GET", RESOURCES, {
    query: { order_by: "name", limit: "500", ...whereParams({ schema: { _eq: "totalbase" }, type: { _eq: "TABLE" }, status: { _eq: "ACTIVE" } }) },
  });
  const exposed = resources.filter((r) => r.exposed_methods.length > 0);
  const rows = exposed.map((r) => `| ${r.name} | ${r.exposed_methods.join(", ")} | ${TOTALBASE_TABLES[r.name] ?? ""} |`);
  return `# TotalBase's own tables

Schema totalbase. They are data like any other - query_records and write_records reach them through the Data API, under grants (administrators bypass them) - with an exposure TotalBase fixes and guardrails no grant lifts:
- tables that grant access or change how the system behaves (permissions, capabilities, object access, menus, resources, settings, secrets) are written by administrators only, and permissions and settings only through their own tools / routes;
- protected columns (password_hash, token and key hashes, storage keys, log SQL) are never readable or writable;
- a user's sign-in identity and security state (email, can_login, lock) are administrator-written; a new account goes through create_user.

Exposed on this instance (others are not reachable through the Data API):

| Table | Methods | What it is |
|---|---|---|
${rows.join("\n")}

users is extensible: the developer may add columns of their own (alter_table on schema totalbase, table users) - a branch, a department - and use them in row filters as $USER.<column>. Never drop or change TotalBase's own columns.`;
}

/**
 * Every step's configuration, from the operation catalog (`@totalbase/tb-catalog`) the server checks a save against:
 * the fields it takes and what each takes, what it can't be published without, its outputs.
 */
export function operationReference(): string {
  const lines = operationMenu().flatMap(({ group, operations }) => [
    `### ${group.label}`,
    ...operations.map((op) => {
      const fields = op.configuration.type === "object" ? Object.entries(op.configuration.fields).map(([name, shape]) => `${name} (${describeShape(shape)})`).join("; ") : describeShape(op.configuration);
      const required = op.required.map((r) => (typeof r.field === "string" ? r.field : r.field.join(" or "))).join(", ");
      const templates = op.templates === "configuration" ? "" : op.templates === "none" ? " Taken literally - no {{templates}}." : ` {{templates}} in ${op.templates.join(", ")}.`;
      return `- ${op.type} - ${op.label}: ${fields}.${required ? ` To publish: ${required}.` : ""} Outputs: ${op.type === "totalbase.select-case" ? "each case's output, default when hasDefault, error" : op.outputs.join(" / ") || "none (it ends the run)"}.${templates}`;
    }),
  ]);
  return `## Configuration reference\nWhat each step's configuration may hold - a save is refused (WORKFLOW_INVALID_DESIGN) for a field a step doesn't have or a value of the wrong kind; every field may be left out of a draft.\n\n${lines.join("\n")}`;
}

async function workflowsGuide(client: AdminClient): Promise<string> {
  const types = await client.get<string[]>("/workflows/operation-types").catch(() => undefined);
  const text = `${WORKFLOWS}\n\n${operationReference()}`;
  return types ? `${text}\n\nPublishable operation types on this instance: ${types.join(", ")}.` : text;
}

interface Guide { name: string; title: string; description: string; text: (client: AdminClient) => string | Promise<string> }

export const GUIDES: Guide[] = [
  { name: "build", title: "How to build on TotalBase", description: "The order things are done in: model, expose, present, roles, grants, users, records, DataViews, dashboards, workflows, publishing.", text: () => BUILD },
  { name: "modeling", title: "Modeling tables", description: "Names, keys, owner and timestamps, types and their widgets, choices (CHECK vs lookup table), relations, validation.", text: () => MODELING },
  { name: "permissions", title: "Permissions", description: "Roles, grants, fields (no wildcard), row filters with $USER, payload checks, capabilities, object access, and how to check them.", text: () => PERMISSIONS },
  { name: "data-api", title: "Data API query language", description: "Filter objects, operators, $USER / $ROW / $INTERVAL / $PERIOD, fields, search, order_by, paging, aggregates, nested creates, upserts, functions.", text: () => DATA_API },
  { name: "totalbase-tables", title: "TotalBase's own tables", description: "Every exposed totalbase.* table on this instance, its methods, what it is and how it is written.", text: totalbaseTablesGuide },
  { name: "files", title: "Files, images and folders", description: "File and image columns (a foreign key to files, never bytea), attachments, uploads and folders.", text: () => FILES },
  { name: "dataviews", title: "DataViews", description: "Each DataView type, when to use it and what it needs; fields; every view_config key; features per type; access.", text: () => DATAVIEWS },
  { name: "pages", title: "Pages", description: "CUSTOM pages and record forms: variables (Value, Resource, Call, record), widgets in areas, bindings, formulas, Code and dataview, and worked patterns.", text: pagesGuide },
  { name: "widgets", title: "Widgets", description: "Every widget a page can hold, from the widget catalog: its props (literal or bound), slots, emits, expose and state.", text: widgetsGuide },
  { name: "dashboards", title: "Dashboard widgets", description: "Widget SQL rules and, per widget type, what its query must return and its config properties.", text: dashboardsGuide },
  { name: "pdf-templates", title: "PDF templates", description: "A pdfme template without the visual designer: fields, bold, multi-variable text, tables and what they push down, and one complete invoice page.", text: () => PDF_TEMPLATES },
  { name: "workflows", title: "Workflows", description: "Definitions, templates, triggers, every operation type's configuration and the lifecycle from draft to production.", text: workflowsGuide },
  { name: "errors", title: "Errors", description: "What each family of error codes means and what to do about it.", text: () => ERRORS },
];

export function registerGuides(server: McpServer, client: AdminClient): void {
  for (const guide of GUIDES) {
    server.registerResource(guide.name, `totalbase://guide/${guide.name}`, { title: guide.title, description: guide.description, mimeType: "text/markdown" }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: await guide.text(client) }],
    }));
  }
}
