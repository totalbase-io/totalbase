import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AdminClient } from "./admin-client.js";
import { IDEMPOTENT, READ_ONLY, result } from "./tool-helpers.js";

/**
 * The App menu (Specification_Security.md §8.2): the arrangement of every
 * published, LISTED DataView and Dashboard in groups - read and replaced
 * whole through the Admin API. Objects are named by slug here; the API
 * takes ids.
 */

interface MenuObject { kind: "DATAVIEW" | "DASHBOARD"; id: string; name: string; slug: string; menuLabel: string | null; description: string | null }
interface MenuGroup { kind: "GROUP"; id: string; name: string; icon: string | null; iconOpen: string | null; openState: "DEFAULT" | "OPEN" | "CLOSED"; children: MenuNode[] }
type MenuNode = MenuGroup | MenuObject;
interface AdminMenu { mode: string; groupsOpen: string; search: string; nodes: MenuNode[]; hidden: MenuObject[] }

interface NodeInput {
  group?: string | undefined;
  id?: string | undefined;
  icon?: string | null | undefined;
  icon_open?: string | null | undefined;
  open?: "default" | "open" | "closed" | undefined;
  children?: NodeInput[] | undefined;
  dataview?: string | undefined;
  dashboard?: string | undefined;
  label?: string | null | undefined;
  description?: string | null | undefined;
}

const nodeInput: z.ZodType<NodeInput> = z.lazy(() =>
  z.object({
    group: z.string().optional().describe("A group's name - its children nest inside it (up to 8 levels)"),
    id: z.string().optional().describe("An existing group's id, to keep it (get_app_menu)"),
    icon: z.string().nullable().optional().describe("A group's Lucide icon - left out on a group kept by id, it keeps the one it had; null clears it"),
    icon_open: z
      .string()
      .nullable()
      .optional()
      .describe("Its icon while open in the tree menu (i-lucide-folder-open beside i-lucide-folder) - kept the same way; none: its icon in both states, or a folder that opens when it has no icon"),
    open: z.enum(["default", "open", "closed"]).optional().describe("How a group starts in the tree menu - default: the menu's groups_open; left out on a group kept by id, it keeps its own"),
    children: z.array(nodeInput).optional(),
    dataview: z.string().optional().describe("A published DataView's slug (or id)"),
    dashboard: z.string().optional().describe("A published dashboard's slug (or id)"),
    label: z.string().max(32).nullable().optional().describe("An item's label in the menu (its menu_label) - left out, it stays; null: its name"),
    description: z.string().max(128).nullable().optional().describe("An item's description, the menu's tooltip - left out, it stays"),
  }),
);

const compact = (nodes: MenuNode[]): unknown[] =>
  nodes.map((n) => (n.kind === "GROUP" ? { group: n.name, id: n.id, ...(n.icon && { icon: n.icon }), ...(n.iconOpen && { icon_open: n.iconOpen }), ...(n.openState !== "DEFAULT" && { open: n.openState.toLowerCase() }), children: compact(n.children) } : { [n.kind === "DATAVIEW" ? "dataview" : "dashboard"]: n.slug, name: n.name, ...(n.menuLabel && { label: n.menuLabel }), ...(n.description && { description: n.description }) }));

export function registerAppTools(server: McpServer, client: AdminClient): void {
  server.registerTool(
    "get_app_menu",
    {
      title: "Get App menu",
      description: "The App menu as administrators arrange it: groups and, in order, every published LISTED DataView and dashboard (by slug); hidden lists the published EMBEDDED_ONLY ones (scope - update_dataview / update_dashboard - shows them). Each viewer sees only what they may open.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const menu = await client.get<AdminMenu>("/app/menu");
      return result({ mode: menu.mode, groups_open: menu.groupsOpen.toLowerCase(), search: menu.search.toLowerCase(), nodes: compact(menu.nodes), hidden: menu.hidden.map((h) => ({ [h.kind === "DATAVIEW" ? "dataview" : "dashboard"]: h.slug, name: h.name })) });
    },
  );

  server.registerTool(
    "check_app",
    {
      title: "Check the App",
      description:
        "What still stops the App from working, and for whom - the admin's own warnings (Specification_DataViews.md §18). Per DataView and dashboard: not published, no role opens it, a column its source no longer has; and per role that opens a DataView: no READ on its source, a foreign key it sees as an id, a page variable refused (warnings), columns it may not read or a write the DataView offers but it may not make (info - often intended). Each issue says what fixes it: publish_*, set_*_roles, set_permission. Run it after a build; an empty list means nothing stops it. One object: dataview or dashboard (slug or id).",
      inputSchema: {
        dataview: z.string().optional().describe("Only this DataView (slug or id)"),
        dashboard: z.string().optional().describe("Only this dashboard (slug or id)"),
      },
      annotations: READ_ONLY,
    },
    async ({ dataview, dashboard }) => {
      type Issue = { code: string; severity: string; message: string };
      type Found = { kind: "DATAVIEW" | "DASHBOARD"; id: string; name: string; slug: string; issues: Issue[] };
      const all = await client.get<Found[]>("/diagnosis");
      const wanted = dataview ?? dashboard;
      const found = wanted ? all.filter((f) => f.kind === (dataview ? "DATAVIEW" : "DASHBOARD") && (f.slug === wanted || f.id === wanted)) : all;
      const warnings = found.reduce((n, f) => n + f.issues.filter((i) => i.severity === "warning").length, 0);
      return result({
        warnings,
        objects: found.map((f) => ({ [f.kind === "DATAVIEW" ? "dataview" : "dashboard"]: f.slug, name: f.name, issues: f.issues.map((i) => ({ code: i.code, severity: i.severity, message: i.message })) })),
      });
    },
  );

  server.registerTool(
    "set_app_menu",
    {
      title: "Set App menu",
      description:
        "Replace the App menu's arrangement in one go: an ordered list of groups ({group, icon?, icon_open?, open? default|open|closed, id? to keep one, children}) and items ({dataview: slug} or {dashboard: slug}, with label? and description? - what the menu shows and its tooltip). Only published, LISTED objects are placed; one left out goes at the end of the root; one placed twice is refused. Answers the resulting menu.",
      inputSchema: {
        nodes: z.array(nodeInput),
        groups_open: z.enum(["current", "open", "closed"]).optional().describe("How the tree menu's groups start when a group says default: current - only the one holding the page (the default), open, closed"),
        search: z.enum(["auto", "always", "never"]).optional().describe("The menu's search box: auto - once a viewer sees more than 15 entries (the default), always, never"),
      },
      annotations: IDEMPOTENT,
    },
    async ({ nodes, groups_open, search }) => {
      if (groups_open) await client.patch("/settings/app", { data: { menu_groups_open: groups_open.toUpperCase() } });
      if (search) await client.patch("/settings/app", { data: { menu_search: search.toUpperCase() } });
      const [dataviews, dashboards, current] = await Promise.all([
        client.get<{ id: string; slug: string }[]>("/dataviews"),
        client.get<{ id: string; slug: string }[]>("/dashboards"),
        client.get<AdminMenu>("/app/menu"),
      ]);
      // A group kept by id keeps its icon unless one is sent - rearranging never drops it.
      const iconsById = new Map<string, { icon: string | null; iconOpen: string | null; openState: string }>();
      const collect = (list: MenuNode[]): void => {
        for (const n of list) {
          if (n.kind !== "GROUP") continue;
          iconsById.set(n.id, { icon: n.icon, iconOpen: n.iconOpen, openState: n.openState });
          collect(n.children);
        }
      };
      collect(current.nodes);
      const idOf = (list: { id: string; slug: string }[], ref: string, what: string) => {
        const found = list.find((o) => o.slug === ref || o.id === ref);
        if (!found) throw new Error(`No ${what} "${ref}" (list_${what}s).`);
        return found.id;
      };
      const toInput = (node: NodeInput): unknown => {
        if (node.group !== undefined) return { kind: "GROUP", ...(node.id && { id: node.id }), name: node.group, icon: node.icon !== undefined ? node.icon : (node.id ? iconsById.get(node.id)?.icon ?? null : null), iconOpen: node.icon_open !== undefined ? node.icon_open : (node.id ? iconsById.get(node.id)?.iconOpen ?? null : null), openState: node.open !== undefined ? node.open.toUpperCase() : (node.id ? iconsById.get(node.id)?.openState ?? "DEFAULT" : "DEFAULT"), children: (node.children ?? []).map(toInput) };
        if (node.dataview) return { kind: "DATAVIEW", id: idOf(dataviews, node.dataview, "dataview") };
        if (node.dashboard) return { kind: "DASHBOARD", id: idOf(dashboards, node.dashboard, "dashboard") };
        throw new Error("Each node is a group, a dataview or a dashboard.");
      };
      await client.put<AdminMenu>("/app/menu", { data: { nodes: nodes.map(toInput) } });
      // An item's label and description are its own (a DataView's or a dashboard's, live - no publish): set where sent.
      const patches: Promise<unknown>[] = [];
      const walk = (list: NodeInput[]): void => {
        for (const node of list) {
          if (node.children) walk(node.children);
          if (node.label === undefined && node.description === undefined) continue;
          const path = node.dataview ? `/dataviews/${idOf(dataviews, node.dataview, "dataview")}` : node.dashboard ? `/dashboards/${idOf(dashboards, node.dashboard, "dashboard")}` : null;
          if (!path) continue;
          patches.push(client.patch(path, { data: { ...(node.label !== undefined && { menuLabel: node.label }), ...(node.description !== undefined && { description: node.description }) } }));
        }
      };
      walk(nodes);
      await Promise.all(patches);
      const menu = await client.get<AdminMenu>("/app/menu");
      return result({ mode: menu.mode, groups_open: menu.groupsOpen.toLowerCase(), nodes: compact(menu.nodes) });
    },
  );
}
