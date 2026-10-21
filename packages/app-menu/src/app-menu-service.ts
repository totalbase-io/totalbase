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

export type MenuNode = MenuGroup | MenuObject;

/** What the administrator saves: groups (new ones without an id) and items by object id. */
export type MenuInput =
  | { kind: "GROUP"; id?: string; name: string; icon?: string | null; iconOpen?: string | null; openState?: MenuGroupOpenState; children: MenuInput[] }
  | { kind: MenuObjectKind; id: string };

/** How deep groups may nest - bounds the recursion over a saved arrangement (the UI offers two levels). */
export const MENU_MAX_DEPTH = 8;

interface MenuRow {
  id: string;
  parent: string | null;
  kind: "GROUP" | MenuObjectKind;
  dataview: string | null;
  dashboard: string | null;
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
      `SELECT id, parent, kind, dataview, dashboard, name, icon, icon_open, open_state, position FROM totalbase.menus ORDER BY position, created_at`,
    );
    return buildMenuTree(rows, published);
  }

  /** Replaces the whole arrangement in one transaction. PostgreSQL rejects an unknown object (FK) or one placed twice (UNIQUE). */
  async setArrangement(nodes: MenuInput[]): Promise<void> {
    validateArrangement(nodes, 1);
    await this.database.transaction(async (client) => {
      await client.query(`DELETE FROM totalbase.menus`);
      await insertNodes(client, nodes, null);
    });
  }
}

async function insertNodes(client: Queryable, nodes: MenuInput[], parent: string | null): Promise<void> {
  for (const [position, node] of nodes.entries()) {
    if (node.kind === "GROUP") {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO totalbase.menus (id, parent, kind, name, icon, icon_open, open_state, position)
         VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, 'GROUP', $3, $4, $5, $6, $7) RETURNING id`,
        [node.id ?? null, parent, node.name.trim(), node.icon ?? null, node.iconOpen ?? null, node.openState ?? "DEFAULT", position],
      );
      await insertNodes(client, node.children, rows[0]!.id);
    } else {
      await client.query(
        `INSERT INTO totalbase.menus (parent, kind, dataview, dashboard, position) VALUES ($1, $2, $3, $4, $5)`,
        [parent, node.kind, node.kind === "DATAVIEW" ? node.id : null, node.kind === "DASHBOARD" ? node.id : null, position],
      );
    }
  }
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
    } else if (node.kind === "DATAVIEW" || node.kind === "DASHBOARD") {
      if (typeof node.id !== "string") throw new TotalBaseError("INVALID_MENU_PAYLOAD", "A menu item needs its object's id.");
    } else {
      throw new TotalBaseError("INVALID_MENU_PAYLOAD", "A menu entry is a GROUP, a DATAVIEW or a DASHBOARD.");
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
 * Pure: the menu as one viewer sees it - only the objects they may open
 * (`visible`, decided by the caller through both access levels), and no
 * group left without anything to show.
 */
export function pruneMenu(nodes: MenuNode[], visible: (kind: MenuObjectKind, id: string) => boolean): MenuNode[] {
  const pruned: MenuNode[] = [];
  for (const node of nodes) {
    if (node.kind === "GROUP") {
      const children = pruneMenu(node.children, visible);
      if (children.length > 0) pruned.push({ ...node, children });
    } else if (visible(node.kind, node.id)) {
      pruned.push(node);
    }
  }
  return pruned;
}
