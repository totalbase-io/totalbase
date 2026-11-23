import type { Queryable } from "@totalbase/database";

/**
 * What a grant lets its role do that the role's own grants elsewhere suggest it shouldn't (Security.md §6.10, §6.5) -
 * advice returned beside a written grant, never a refusal: both are the documented model, and both are easy to set
 * up by mistake.
 *
 * - A READ grant's related field (`perito.especialidad`) reads the related row without the role's row filter on
 *   that table: the role sees that field of every row a readable row points to.
 * - A CREATE / UPDATE grant lets the role write a foreign key to any row of a table it reads only some of, unless the
 *   grant's row filter or payload checks name that column.
 *
 * Tables of the `totalbase` schema are left out (an owner or creator column pointing at a user is the usual case).
 */
export async function grantAdvisories(database: Queryable, roleId: string, resourceId: string, action: string): Promise<string[]> {
  const { rows } = await database.query<{ effect: string; where_clause: unknown; field_overrides: { field: string; effect: string }[]; payload_checks: { rule: unknown }[]; oid: number; name: string }>(
    `SELECT p.effect, p.where_clause, p.field_overrides, p.payload_checks, r.postgres_oid::int AS oid, r.name
       FROM totalbase.permissions p JOIN totalbase.resources r ON r.id = p.resource
      WHERE p.role = $1 AND p.resource = $2 AND p.action = $3 AND r.type = 'TABLE' AND r.status = 'ACTIVE'`,
    [roleId, resourceId, action],
  );
  const grant = rows[0];
  if (!grant || grant.effect !== "ALLOW") return [];
  const allowed = (grant.field_overrides ?? []).filter((field) => field.effect === "ALLOW").map((field) => field.field);
  const advice: string[] = [];

  if (action === "READ") {
    const seen = new Set<string>();
    for (const path of allowed.filter((field) => field.includes("."))) {
      const segments = path.split(".");
      let oid = grant.oid;
      for (let hop = 0; hop < segments.length - 1; hop++) {
        const target = await foreignKeyTarget(database, oid, segments[hop]!);
        if (!target) break;
        const prefix = segments.slice(0, hop + 1).join(".");
        const filter = target.resource ? await readFilter(database, roleId, target.resource) : null;
        if (filter && !seen.has(prefix)) {
          seen.add(prefix);
          advice.push(`"${path}" reads ${target.name} through ${prefix} without this role's row filter on ${target.name} (${JSON.stringify(filter)}): it sees that field of every ${target.name} row a ${grant.name} row points to. Leave it out if those rows aren't all safe for the role.`);
        }
        oid = target.oid;
      }
    }
  }

  if (action === "CREATE" || action === "UPDATE") {
    const constrained = new Set([grant.where_clause, ...(grant.payload_checks ?? []).map((check) => check.rule)].flatMap(filterPaths).map((path) => path.split(".")[0]!));
    for (const column of allowed.filter((field) => !field.includes("."))) {
      if (constrained.has(column)) continue;
      const target = await foreignKeyTarget(database, grant.oid, column);
      if (!target?.resource) continue;
      const filter = await readFilter(database, roleId, target.resource);
      if (filter) {
        advice.push(`${grant.name}.${column} may point at any ${target.name} row, while this role reads only some (${JSON.stringify(filter)}): name ${column} in this grant's row filter or a payload check (e.g. {"${column}.<column>": ...}) if it should stay among those.`);
      }
    }
  }
  return advice;
}

/** A single-column foreign key's target, outside the `totalbase` schema, and its active resource when it has one. */
async function foreignKeyTarget(database: Queryable, oid: number, column: string): Promise<{ oid: number; name: string; resource: string | null } | null> {
  const { rows } = await database.query<{ oid: number; name: string; resource: string | null }>(
    `SELECT c.confrelid::int AS oid, t.relname AS name, r.id AS resource
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       JOIN pg_class t ON t.oid = c.confrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       LEFT JOIN totalbase.resources r ON r.postgres_oid = c.confrelid AND r.status = 'ACTIVE'
      WHERE c.conrelid = $1::oid AND c.contype = 'f' AND cardinality(c.conkey) = 1 AND a.attname = $2 AND n.nspname <> 'totalbase'
      LIMIT 1`,
    [oid, column],
  );
  return rows[0] ?? null;
}

/** The role's own READ row filter on a resource - null when it reads every row, or nothing. */
async function readFilter(database: Queryable, roleId: string, resourceId: string): Promise<unknown> {
  const { rows } = await database.query<{ where_clause: unknown }>(
    `SELECT where_clause FROM totalbase.permissions WHERE role = $1 AND resource = $2 AND action = 'READ' AND effect = 'ALLOW'`,
    [roleId, resourceId],
  );
  const filter = rows[0]?.where_clause;
  return filter && typeof filter === "object" && Object.keys(filter).length > 0 ? filter : null;
}

/** The field paths a stored filter names (its keys that aren't operators), at any depth. */
function filterPaths(filter: unknown): string[] {
  if (Array.isArray(filter)) return filter.flatMap(filterPaths);
  if (!filter || typeof filter !== "object") return [];
  return Object.entries(filter).flatMap(([key, value]) => (key.startsWith("_") ? filterPaths(value) : [key]));
}
