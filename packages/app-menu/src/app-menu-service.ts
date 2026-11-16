import { randomUUID } from "node:crypto";
import type { Database, Queryable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";

/**
 * The App menu (Security.md §8): one per instance,
 * arranged by the administrator, stored in `totalbase.menus`.
 * This package owns that table only - which DataViews and Dashboards are
 * published (and what they are called) is handed in by the caller, so it
 * never reads another package's tables.
 */

export type MenuObjectKind = "DATAVIEW" | "DASHBOARD";

/** The portal modules the menu can hold as entries - the delegated modules of Security.md §9.2, by the names `GET /auth/me`'s `modules` uses. */
export const MENU_MODULES = ["users", "roles", "files", "templates", "logs"] as const;
export type MenuModuleName = (typeof MENU_MODULES)[number];

/** A delegated module placed in the menu (Security.md §8.2): shown to a viewer whose roles read its table, like the rail. */
export interface MenuModule {
  kind: "MODULE";
  id: string;
  module: MenuModuleName;
  /** What the menu shows - null: the module's own name. */
  name: string | null;
  /** null: the module's own icon. */
  icon: string | null;
}

/** A published object the menu can show. */
export interface MenuObject {
  kind: MenuObjectKind;
  id: string;
  name: string;
  slug: string;
  /** What the menu shows - null: its name. */
  menuLabel: string | null;
  /** Its description - the menu's tooltip. */
  description: string | null;
  icon: string | null;
  color: string | null;
  /** DataViews only - its layout (TABLE, KANBAN, ...). */
  viewType: string | null;
}

export interface MenuGroup {
  kind: "GROUP";
  id: string;
  name: string;
  icon: string | null;
  /** Shown instead of `icon` while the group is open in the tree menu - null: `icon` in both states. */
  iconOpen: string | null;
  /** How it starts in the tree menu: DEFAULT - the menu's own setting (app.menu_groups_open). */
  openState: MenuGroupOpenState;
  children: MenuNode[];
}

export const MENU_GROUP_OPEN_STATES = ["DEFAULT", "OPEN", "CLOSED"] as const;
export type MenuGroupOpenState = (typeof MENU_GROUP_OPEN_STATES)[number];

/** What a viewer opens: an object, or a module. */
export type MenuEntry = MenuObject | MenuModule;
export type MenuNode = MenuGroup | MenuEntry;

/** What the administrator saves: groups and modules (new ones without an id) and items by object id. */
export type MenuInput =
  | { kind: "GROUP"; id?: string; name: string; icon?: string | null; iconOpen?: string | null; openState?: MenuGroupOpenState; children: MenuInput[] }
  | { kind: "MODULE"; id?: string; module: MenuModuleName; name?: string | null; icon?: string | null }
  | { kind: MenuObjectKind; id: string };

/** How deep groups may nest - bounds the recursion over a saved arrangement (the UI offers two levels). */
export const MENU_MAX_DEPTH = 8;

interface MenuRow {
  id: string;
  parent: string | null;
  kind: "GROUP" | "MODULE" | MenuObjectKind;
  dataview: string | null;
  dashboard: string | null;
  module: MenuModuleName | null;
  name: string | null;
  icon: string | null;
  icon_open: string | null;
  open_state: MenuGroupOpenState;
  position: number;
}

export class AppMenuService {
  constructor(private readonly database: Database) {}

  /**
   * The full menu over `published`: the stored arrangement, minus items
   * whose object is no longer among `published`, plus every published
   * object with no place yet, appended to the root in `published` order.
   */
  async tree(published: MenuObject[]): Promise<MenuNode[]> {
    const { rows } = await this.database.query<MenuRow>(
      `SELECT id, parent, kind, dataview, dashboard, module, name, icon, icon_open, open_state, position FROM totalbase.menus ORDER BY position, created_at`,
    );
    return buildMenuTree(rows, published);
  }

  /** Replaces the whole arrangement in one transaction. PostgreSQL rejects an unknown object (FK), an unknown module (CHECK) or one placed twice (UNIQUE). */
  async setArrangement(nodes: MenuInput[]): Promise<void> {
    validateArrangement(nodes, 1);
    await this.database.transaction(async (client) => {
      await client.query(`DELETE FROM totalbase.menus`);
      await insertNodes(client, nodes, null);
    });
  }
}

/** One menu row as the arrangement writes it - its id given here, so a child names its group within the same batch. */
interface MenuRowInput {
  id: string;
  parent: string | null;
  kind: string;
  dataview: string | null;
  dashboard: string | null;
  module: string | null;
  name: string | null;
  icon: string | null;
  icon_open: string | null;
  open_state: string | null;
  position: number;
}

/** The tree as rows, parents before children - each group's id known before its children name it. */
function flatten(nodes: MenuInput[], parent: string | null, rows: MenuRowInput[] = []): MenuRowInput[] {
  for (const [position, node] of nodes.entries()) {
    const base = { parent, position, dataview: null, dashboard: null, module: null, name: null, icon: null, icon_open: null, open_state: null };
    if (node.kind === "GROUP") {
      const id = node.id ?? randomUUID();
      rows.push({ ...base, id, kind: "GROUP", name: node.name.trim(), icon: node.icon ?? null, icon_open: node.iconOpen ?? null, open_state: node.openState ?? "DEFAULT" });
      flatten(node.children, id, rows);
    } else if (node.kind === "MODULE") {
      rows.push({ ...base, id: node.id ?? randomUUID(), kind: "MODULE", module: node.module, name: node.name?.trim() || null, icon: node.icon ?? null });
    } else {
      rows.push({ ...base, id: randomUUID(), kind: node.kind, dataview: node.kind === "DATAVIEW" ? node.id : null, dashboard: node.kind === "DASHBOARD" ? node.id : null });
    }
  }
  return rows;
}

/** The whole arrangement in one statement - a child's `parent` is checked once the statement ends, its group inserted with it. */
async function insertNodes(client: Queryable, nodes: MenuInput[], parent: string | null): Promise<void> {
  const rows = flatten(nodes, parent);
  if (rows.length === 0) return;
  await client.query(
    `INSERT INTO totalbase.menus (id, parent, kind, dataview, dashboard, module, name, icon, icon_open, open_state, position)
     SELECT m.id, m.parent, m.kind, m.dataview, m.dashboard, m.module, m.name, m.icon, m.icon_open, COALESCE(m.open_state, 'DEFAULT'), m.position
     FROM jsonb_to_recordset($1::jsonb) AS m(id uuid, parent uuid, kind text, dataview uuid, dashboard uuid, module text, name text, icon text,
       icon_open text, open_state text, position integer)`,
    [JSON.stringify(rows)],
  );
}

/** Shape only - names, lengths, uniqueness and existence are PostgreSQL's (CHECK, FK, UNIQUE). */
function validateArrangement(nodes: unknown, depth: number): asserts nodes is MenuInput[] {
  if (!Array.isArray(nodes)) throw new TotalBaseError("INVALID_MENU_PAYLOAD", "The menu must be a list of entries.");
  if (depth > MENU_MAX_DEPTH) throw new TotalBaseError("INVALID_MENU_PAYLOAD", `Menu groups can nest at most ${MENU_MAX_DEPTH} levels.`);
  for (const node of nodes as Record<string, unknown>[]) {
    if (node === null || typeof node !== "object") throw new TotalBaseError("INVALID_MENU_PAYLOAD", "Invalid menu entry.");
    if (node.kind === "GROUP") {
      if (typeof node.name !== "string") throw new TotalBaseError("INVALID_MENU_PAYLOAD", "A menu group needs a name.");
      if (node.id !== undefined && typeof node.id !== "string") throw new TotalBaseError("INVALID_MENU_PAYLOAD", "Invalid menu group id.");
      if (node.icon !== undefined && node.icon !== null && typeof node.icon !== "string") throw new TotalBaseError("INVALID_MENU_PAYLOAD", "Invalid menu group icon.");
      if (node.iconOpen !== undefined && node.iconOpen !== null && typeof node.iconOpen !== "string") throw new TotalBaseError("INVALID_MENU_PAYLOAD", "Invalid menu group open icon.");
      if (node.openState !== undefined && !(MENU_GROUP_OPEN_STATES as readonly unknown[]).includes(node.openState)) throw new TotalBaseError("INVALID_MENU_PAYLOAD", "A menu group's openState is DEFAULT, OPEN or CLOSED.");
      validateArrangement(node.children, depth + 1);
    } else if (node.kind === "MODULE") {
      if (!(MENU_MODULES as readonly unknown[]).includes(node.module)) throw new TotalBaseError("INVALID_MENU_PAYLOAD", `A menu module is one of ${MENU_MODULES.join(", ")}.`);
      if (node.id !== undefined && typeof node.id !== "string") throw new TotalBaseError("INVALID_MENU_PAYLOAD", "Invalid menu module id.");
      if (node.name !== undefined && node.name !== null && typeof node.name !== "string") throw new TotalBaseError("INVALID_MENU_PAYLOAD", "Invalid menu module name.");
      if (node.icon !== undefined && node.icon !== null && typeof node.icon !== "string") throw new TotalBaseError("INVALID_MENU_PAYLOAD", "Invalid menu module icon.");
    } else if (node.kind === "DATAVIEW" || node.kind === "DASHBOARD") {
      if (typeof node.id !== "string") throw new TotalBaseError("INVALID_MENU_PAYLOAD", "A menu item needs its object's id.");
    } else {
      throw new TotalBaseError("INVALID_MENU_PAYLOAD", "A menu entry is a GROUP, a MODULE, a DATAVIEW or a DASHBOARD.");
    }
  }
}

const objectKey = (kind: MenuObjectKind, id: string) => `${kind}:${id}`;

/** Pure: stored rows + published objects -> the menu tree (see AppMenuService.tree). */
export function buildMenuTree(rows: MenuRow[], published: MenuObject[]): MenuNode[] {
  const objects = new Map(published.map((object) => [objectKey(object.kind, object.id), object]));
  const placed = new Set<string>();
  const childrenOf = new Map<string | null, MenuRow[]>();
  for (const row of rows) {
    const siblings = childrenOf.get(row.parent) ?? [];
    siblings.push(row);
    childrenOf.set(row.parent, siblings);
  }
  const build = (parent: string | null): MenuNode[] => {
    const nodes: MenuNode[] = [];
    for (const row of (childrenOf.get(parent) ?? []).sort((a, b) => a.position - b.position)) {
      if (row.kind === "GROUP") {
        nodes.push({ kind: "GROUP", id: row.id, name: row.name ?? "", icon: row.icon, iconOpen: row.icon_open, openState: row.open_state ?? "DEFAULT", children: build(row.id) });
        continue;
      }
      if (row.kind === "MODULE") {
        if (row.module) nodes.push({ kind: "MODULE", id: row.id, module: row.module, name: row.name, icon: row.icon });
        continue;
      }
      const key = objectKey(row.kind, (row.kind === "DATAVIEW" ? row.dataview : row.dashboard)!);
      const object = objects.get(key);
      if (!object) continue;
      placed.add(key);
      nodes.push(object);
    }
    return nodes;
  };
  const root = build(null);
  for (const object of published) {
    if (!placed.has(objectKey(object.kind, object.id))) root.push(object);
  }
  return root;
}

/**
 * Pure: the menu as one viewer sees it - only the entries they may open
 * (`visible`, decided by the caller: an object through both access levels,
 * a module by READ on its table), and no group left without anything to show.
 */
export function pruneMenu(nodes: MenuNode[], visible: (entry: MenuEntry) => boolean): MenuNode[] {
  const pruned: MenuNode[] = [];
  for (const node of nodes) {
    if (node.kind === "GROUP") {
      const children = pruneMenu(node.children, visible);
      if (children.length > 0) pruned.push({ ...node, children });
    } else if (visible(node)) {
      pruned.push(node);
    }
  }
  return pruned;
}
