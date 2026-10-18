import type { AppContext } from "./context.js";

/** The portal modules a non-administrator can be delegated, and the table each one's visibility follows (Specification_Security.md §9.2). */
export const DELEGATED_MODULE_TABLES = {
  users: "users",
  roles: "roles",
  files: "files",
  templates: "templates",
  logs: "logs",
} as const;

export type DelegatedModule = keyof typeof DELEGATED_MODULE_TABLES;
const ALL_MODULES = Object.keys(DELEGATED_MODULE_TABLES) as DelegatedModule[];
const ACTIONS = ["READ", "CREATE", "UPDATE", "DELETE"] as const;
type ModuleAction = (typeof ACTIONS)[number];

/** Tables a module's screen writes besides its own (the Files screen's folders; role assignments on Roles and Users) - their actions ride along, but they are not rail modules. */
const COMPANION_TABLES = { folders: "folders", assignments: "users_roles" } as const;
type Companion = keyof typeof COMPANION_TABLES;
/** The modules whose screen manages each companion table - it comes along only with one of them. */
const COMPANION_OF: Record<Companion, DelegatedModule[]> = { folders: ["files"], assignments: ["roles", "users"] };
/** The keys of DelegatedModuleActions that are companions, not rail modules. */
export const COMPANIONS = Object.keys(COMPANION_TABLES) as Companion[];

/** Per module the user sees (plus its companion tables), the actions their roles hold on its table - so a screen offers only what they may do. */
export type DelegatedModuleActions = Partial<Record<DelegatedModule | Companion, ModuleAction[]>>;

/**
 * The delegated modules a portal user sees in the rail, each with the
 * actions they may take on its table: every one for an administrator;
 * otherwise those whose table the Data API exposes for GET and their roles
 * hold READ on. The permission is the whole rule - there is no separate
 * "module access" flag.
 */
export async function delegatedModuleActions(context: AppContext, roleIds: string[]): Promise<DelegatedModuleActions> {
  if (await context.roles.isAdministrator(roleIds)) {
    return Object.fromEntries([...ALL_MODULES, ...Object.keys(COMPANION_TABLES)].map((m) => [m, [...ACTIONS]]));
  }
  const { rows } = await context.database.query<{ id: string; name: string }>(
    `SELECT id, name FROM totalbase.resources
     WHERE "schema" = 'totalbase' AND name = ANY($1) AND status = 'ACTIVE' AND 'GET' = ANY(exposed_methods)`,
    [[...Object.values(DELEGATED_MODULE_TABLES), ...Object.values(COMPANION_TABLES)]],
  );
  const decisions = await context.effectivePermissions.resolveBulk(roleIds, rows.map((r) => r.id));
  const byTable = new Map(rows.map((r) => [r.name, decisions.get(r.id)]));
  const result: DelegatedModuleActions = {};
  for (const module of ALL_MODULES) {
    const decision = byTable.get(DELEGATED_MODULE_TABLES[module]);
    if (decision?.READ.decision !== "ALLOW") continue;
    result[module] = ACTIONS.filter((action) => decision[action].decision === "ALLOW");
  }
  for (const companion of COMPANIONS) {
    const decision = byTable.get(COMPANION_TABLES[companion]);
    if (decision && COMPANION_OF[companion].some((module) => result[module])) {
      result[companion] = ACTIONS.filter((action) => decision[action].decision === "ALLOW");
    }
  }
  return result;
}
