import { isProtectedField } from "@totalbase/mutations";
import type { ResourceAction } from "@totalbase/permissions";
import type { AppContext } from "./context.js";

/**
 * "Apply default permissions" on TotalBase's own tables
 * (Security.md §10.5): the grants a fresh role needs to use
 * the App as an ordinary user - its own account, sessions, files and
 * activity - judged safe as a default. Anything not listed gets no grant (absence is
 * denial), and an existing grant on an unlisted table is never touched.
 * A grant the role already holds for a listed (table, action) is kept as it
 * is - broader, narrower or a DENY: the author's own grant always wins over
 * a default, which only fills what is missing.
 *
 * Left out on purpose: the tables that grant access or hide writes
 * (permissions, resources, capabilities, audits exclusions...) and the
 * platform's plumbing and credentials (providers, tokens, secrets,
 * settings, queries, executions, outbox, identities...) - and of the audit
 * log, everything beyond one's own entries' what, when and where from.
 */
interface DefaultAction {
  action: ResourceAction;
  /** Row filter (the filter grammar); omitted = every row. */
  where?: Record<string, unknown>;
  /**
   * The only fields granted; omitted = every column but the protected ones
   * and `excludeFields`. A dotted path is a relation path
   * (Security.md §6.10), granted as it is.
   */
  fields?: string[];
}

interface DefaultGrant {
  table: string;
  excludeFields?: string[];
  actions: DefaultAction[];
}

const OWN_ROW = { id: { _eq: "$USER.id" } };
const OWN_USER = { user: { _eq: "$USER.id" } };
const CREATED_BY_ME = { created_by: { _eq: "$USER.id" } };
const MY_ENTRIES = { principal: { _eq: "$USER.id" } };

export const TOTALBASE_DEFAULT_GRANTS: DefaultGrant[] = [
  // Everyone reads and uploads; a file is changed or deleted by whoever uploaded it.
  {
    table: "files",
    actions: [
      { action: "CREATE" },
      { action: "READ" },
      { action: "UPDATE", where: CREATED_BY_ME },
      { action: "DELETE", where: CREATED_BY_ME },
    ],
  },
  // The file picker's tree: the same rule as files.
  {
    table: "folders",
    actions: [
      { action: "CREATE" },
      { action: "READ" },
      { action: "UPDATE", where: CREATED_BY_ME },
      { action: "DELETE", where: CREATED_BY_ME },
    ],
  },
  { table: "templates", actions: [{ action: "READ" }] },
  // One's own account; changed only in its personal columns - never a
  // column the developer added (a department, a salary).
  {
    table: "users",
    excludeFields: ["owner"],
    actions: [
      { action: "READ", where: OWN_ROW },
      { action: "UPDATE", where: OWN_ROW, fields: ["name", "avatar_url", "preferences"] },
    ],
  },
  { table: "roles", actions: [{ action: "READ" }] },
  { table: "users_roles", actions: [{ action: "READ", where: OWN_USER }] },
  // One's own sessions; signing one out is setting revoked_at (sessions are never deleted).
  {
    table: "sessions",
    actions: [
      { action: "READ", where: OWN_USER },
      { action: "UPDATE", where: OWN_USER, fields: ["revoked_at"] },
    ],
  },
  // One's own activity (My account > Activity): what, when, on what, where
  // from - never the payload, changes, filter or metadata, which can hold
  // what a user must not read back (another row's values, a column they
  // can't read). The table's name through the relation path: the registry
  // itself stays unreadable.
  {
    table: "logs",
    actions: [
      {
        action: "READ",
        where: MY_ENTRIES,
        fields: [
          "id", "request_id", "principal_type", "principal", "resource", "action", "event", "status", "source",
          "ip", "user_agent", "error_code", "error_message", "duration_ms", "created_at",
          "resource.schema", "resource.name",
        ],
      },
    ],
  },
];

export interface AppliedDefaultGrants {
  applied: { table: string; action: ResourceAction }[];
  /** Listed (table, action) pairs the role already had a grant for - left as they were. */
  kept: { table: string; action: ResourceAction }[];
  /** Listed tables with no ACTIVE resource on this instance. */
  missing: string[];
}

/** Applies TOTALBASE_DEFAULT_GRANTS to one role, each grant as the role matrix's own PUT would - only where the role has none yet, so applying twice changes nothing and an author's own grant is never replaced. */
export async function applyTotalbaseDefaultGrants(context: AppContext, roleId: string): Promise<AppliedDefaultGrants> {
  const { rows: resources } = await context.database.query<{ id: string; name: string; postgres_oid: number }>(
    `SELECT id, name, postgres_oid FROM totalbase.resources
     WHERE "schema" = 'totalbase' AND status = 'ACTIVE' AND name = ANY($1)`,
    [TOTALBASE_DEFAULT_GRANTS.map((grant) => grant.table)],
  );
  const { rows: columns } = await context.database.query<{ oid: number; name: string }>(
    `SELECT attrelid::int AS oid, attname AS name FROM pg_attribute
     WHERE attrelid = ANY($1::oid[]) AND attnum > 0 AND NOT attisdropped ORDER BY attnum`,
    [resources.map((resource) => resource.postgres_oid)],
  );

  const { rows: existing } = await context.database.query<{ resource: string; action: ResourceAction }>(
    `SELECT resource, action FROM totalbase.permissions WHERE role = $1 AND resource = ANY($2::uuid[])`,
    [roleId, resources.map((resource) => resource.id)],
  );
  const held = new Set(existing.map((grant) => `${grant.resource}|${grant.action}`));

  const result: AppliedDefaultGrants = { applied: [], kept: [], missing: [] };
  for (const grant of TOTALBASE_DEFAULT_GRANTS) {
    const resource = resources.find((r) => r.name === grant.table);
    if (!resource) {
      result.missing.push(grant.table);
      continue;
    }
    const excluded = new Set(grant.excludeFields ?? []);
    const grantable = columns
      .filter((c) => c.oid === resource.postgres_oid && !isProtectedField("totalbase", grant.table, c.name) && !excluded.has(c.name))
      .map((c) => c.name);
    for (const { action, where, fields } of grant.actions) {
      if (held.has(`${resource.id}|${action}`)) {
        result.kept.push({ table: grant.table, action });
        continue;
      }
      const granted = fields ? [...grantable.filter((name) => fields.includes(name)), ...fields.filter((name) => name.includes("."))] : grantable;
      await context.permissions.set(roleId, resource.id, action, {
        effect: "ALLOW",
        where: where ?? null,
        fields: granted.map((field) => ({ field, effect: "ALLOW" as const })),
      });
      result.applied.push({ table: grant.table, action });
    }
  }
  return result;
}
