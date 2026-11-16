import type { Queryable } from "@totalbase/database";

/** An object a role is given access to (Security.md §7): it decides who may open it, never what data they read. */
export type ObjectKind = "dataviews" | "dashboards" | "workflows";

const OBJECT_TABLES: Record<ObjectKind, { table: string; column: string }> = {
  dataviews: { table: "dataviews_roles", column: "dataview" },
  dashboards: { table: "dashboards_roles", column: "dashboard" },
  workflows: { table: "workflows_roles", column: "workflow" },
};

export const OBJECT_KINDS = Object.keys(OBJECT_TABLES) as ObjectKind[];

export function isObjectKind(value: string): value is ObjectKind {
  return value in OBJECT_TABLES;
}

/**
 * The objects of a kind these roles open (their object access, granted directly), by name - each with whether
 * `role` opens it too. What a manager may share with a role below theirs is among these (Security.md §9.7).
 */
export async function objectsOpenedBy(database: Queryable, kind: ObjectKind, roleIds: string[], role: string): Promise<{ id: string; name: string; granted: boolean }[]> {
  const { table, column } = OBJECT_TABLES[kind];
  const { rows } = await database.query<{ id: string; name: string; granted: boolean }>(
    `SELECT o.id, o.name, EXISTS (SELECT 1 FROM totalbase.${table} g WHERE g.${column} = o.id AND g.role = $1) AS granted
     FROM totalbase.${kind} o
     WHERE EXISTS (SELECT 1 FROM totalbase.${table} m WHERE m.${column} = o.id AND m.role = ANY($2::uuid[]))
     ORDER BY o.name`,
    [role, roleIds],
  );
  return rows;
}

/** Whether one of these roles opens the object, granted directly. */
export async function opensObject(database: Queryable, kind: ObjectKind, id: string, roleIds: string[]): Promise<boolean> {
  const { table, column } = OBJECT_TABLES[kind];
  const { rows } = await database.query(`SELECT 1 FROM totalbase.${table} WHERE ${column} = $1 AND role = ANY($2::uuid[])`, [id, roleIds]);
  return rows.length > 0;
}

/** Opens the object to a role - already open is fine. */
export async function grantObject(database: Queryable, kind: ObjectKind, id: string, role: string): Promise<void> {
  const { table, column } = OBJECT_TABLES[kind];
  await database.query(`INSERT INTO totalbase.${table} (${column}, role) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, role]);
}

/** Closes the object to a role; false when the role didn't open it. */
export async function revokeObject(database: Queryable, kind: ObjectKind, id: string, role: string): Promise<boolean> {
  const { table, column } = OBJECT_TABLES[kind];
  const { rowCount } = await database.query(`DELETE FROM totalbase.${table} WHERE ${column} = $1 AND role = $2`, [id, role]);
  return (rowCount ?? 0) > 0;
}
