import { dataEnvelope, type JsonSchema, type RouteDoc } from "@totalbase/openapi";
import { COMPARISON_OPERATORS, LOGICAL_OPERATORS } from "@totalbase/query-engine";

/**
 * Shared pieces for Admin API routes' `config.openapi` (the same RouteDoc
 * mechanism the Data API's fixed routes use). Schemas mirror the service
 * return types they name; `$ref`s point at the components registered here.
 */

export const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });
export const arrayOf = (schema: JsonSchema): JsonSchema => ({ type: "array", items: schema });
export const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object",
  ...(required.length > 0 ? { required } : {}),
  properties,
});
export const UUID: JsonSchema = { type: "string", format: "uuid" };
export const DATE_TIME: JsonSchema = { type: "string", format: "date-time" };
const nullable = (schema: JsonSchema): JsonSchema => ({ ...schema, type: [schema.type as string, "null"] });

/** `{ config: { openapi } }` for an admin route: bearer-authenticated (an admin session or admin-plane token) unless marked public. */
export function adminDoc(tag: string, openapi: Omit<RouteDoc, "tags" | "access"> & { access?: RouteDoc["access"] }) {
  return { config: { openapi: { tags: [tag], access: "principal" as const, ...openapi } } };
}

/** 200 `{ data: <schema> }`. */
export const ok = (schema: JsonSchema) => ({ status: "200" as const, schema: dataEnvelope(schema) });
export const created = (schema: JsonSchema) => ({ status: "201" as const, schema: dataEnvelope(schema) });
export const NO_CONTENT = { status: "204" as const };
export const UUID_PARAM = { schema: UUID };

/**
 * The one filter-object grammar (AGENTS.md section 7): `{ field: { _op: value } }`
 * with `_and`/`_or`/`_not`, as used by Data API `where[...]`, row filters
 * and payload checks.
 */
export const FILTER: JsonSchema = {
  type: "object",
  additionalProperties: true,
  description:
    "Filter object: `{ \"<field>\": { \"_eq\": value } }`, combined with " + LOGICAL_OPERATORS.join("/") +
    ". Operators: " + COMPARISON_OPERATORS.join(", ") + ". Values may use $USER.<field>, $INTERVAL.<n><unit> and $PERIOD.<period>.<from|to>.",
};

const ACTION: JsonSchema = { type: "string", enum: ["CREATE", "READ", "UPDATE", "DELETE", "EXECUTE"] };
const EFFECT: JsonSchema = { type: "string", enum: ["ALLOW", "DENY"] };
const DECISION: JsonSchema = { type: "string", enum: ["ALLOW", "DENY", "UNDEFINED"] };

export const ADMIN_SCHEMAS: Record<string, JsonSchema> = {
  Role: object({
    id: UUID,
    name: { type: "string" },
    description: nullable({ type: "string" }),
    icon: nullable({ type: "string" }),
    color: nullable({ type: "string" }),
    active: { type: "boolean" },
    reserved: { type: "boolean", description: "The seeded Administrators/Workflows roles: can't be renamed, deactivated or deleted." },
    adminAccess: { type: "boolean", description: "Only ever true on a reserved role." },
    appAccess: { type: "boolean", description: "Members can sign in to the app portal." },
    apiAccess: { type: "boolean", description: "Members can obtain Data API sessions and keys." },
    createdAt: DATE_TIME,
  }),
  Permission: object({
    id: UUID,
    role: UUID,
    resource: UUID,
    action: ACTION,
    effect: EFFECT,
    whereClause: { ...FILTER, type: ["object", "null"], description: "Row filter (null = every row)." },
    fields: arrayOf(object({ field: { type: "string" }, effect: EFFECT })),
    payloadChecks: arrayOf(object({ rule: FILTER, label: nullable({ type: "string" }) })),
  }),
  Resource: object({
    id: UUID,
    postgresOid: { type: "integer" },
    schema: { type: "string" },
    name: { type: "string" },
    type: { type: "string", enum: ["TABLE", "VIEW", "FUNCTION"] },
    status: { type: "string", enum: ["ACTIVE", "MISSING"] },
    exposedMethods: arrayOf({ type: "string", enum: ["GET", "POST", "PATCH", "DELETE", "REALTIME"] }),
    exposureFixed: { type: "boolean", description: "TotalBase's own tables: `exposedMethods` is fixed by TotalBase (Security.md §10.1), access decided by grants alone." },
    description: nullable({ type: "string" }),
    functionClass: { type: ["string", "null"], enum: ["UNCLASSIFIED", "QUERY", "ACTION", null] },
    auditRead: { type: "boolean" },
    requireIdempotencyKey: { type: "boolean", description: "A TABLE's CREATE or a FUNCTION's EXECUTE needs an Idempotency-Key (400 IDEMPOTENCY_KEY_REQUIRED without one)." },
    rowPresentation: {
      ...object({
        displayField: { type: "string", description: "The column shown instead of the key." },
        displayTemplate: { type: "string", description: "Several columns at once, e.g. {{name}} ({{country}}); wins over displayField." },
      }),
      description: "How a row shows wherever a foreign key points at it - inherited by every foreign-key column of every DataView that sets none of its own. `{}` on a FUNCTION.",
    },
    defaultSort: {
      ...arrayOf(object({ column: { type: "string" }, direction: { type: "string", enum: ["asc", "desc"] } }, ["column", "direction"])),
      description: "The order its rows come in when nobody asks for one (the Data API without `order_by`, then the primary key; a new DataView's default). `[]` on a FUNCTION or when unset.",
    },
    createdAt: DATE_TIME,
    updatedAt: DATE_TIME,
  }),
  EffectivePermissions: object({
    resource: UUID,
    actions: {
      type: "object",
      description: "Per action (CREATE/READ/UPDATE/DELETE/EXECUTE).",
      additionalProperties: object({
        decision: DECISION,
        roles: arrayOf(UUID),
        fields: { type: ["array", "null"], items: { type: "string" } },
        rowFilters: { type: ["array", "null"], items: object({ role: UUID, where: FILTER }) },
        payloadChecks: { type: ["array", "null"], items: object({ role: UUID, label: nullable({ type: "string" }), rule: FILTER }) },
      }),
    },
  }),
  SettingsValues: {
    type: "object",
    description: "Current value of every key in the group (fully dotted), the registry default where no override is stored.",
    additionalProperties: true,
  },
  SettingField: object({
    key: { type: "string", description: "Fully dotted, e.g. `api.max_limit`." },
    label: { type: "string" },
    description: { type: "string" },
    unit: { type: "string" },
    section: { type: "string", description: "Subheading it is listed under on its admin page." },
    input: { type: "string", enum: ["secret", "timezone", "regional", "json", "role", "image", "color", "css", "cards", "textarea", "cron"], description: "Widget when the value's type isn't enough: a public image in Files, a hex color, a CSS editor, option cards, plain text on several lines." },
    options: arrayOf(object({ label: { type: "string" }, value: { type: "string" }, description: { type: "string" } })),
    orientation: { type: "string", enum: ["vertical"], description: "Option cards one under the other - unset: side by side." },
    dependsOn: { type: "string", description: "A boolean key that switches this one off." },
    primary: { type: "boolean", description: "The switch that turns the page's whole feature on: shown above everything else, which waits for it." },
    links: {
      ...arrayOf({
        oneOf: [
          object({ setting: { type: "string", description: "Another key - its page, scrolled to it." } }, ["setting"]),
          object({ page: { type: "string", enum: ["secrets", "roles", "templates", "docs"] } }, ["page"]),
        ],
      }),
      description: "Where else to go to make this setting work, shown under its description. A `secret` or `role` input implies Secrets or Roles.",
    },
    default: { description: "Registry default - what the key reads when no override is stored." },
    min: { type: "integer", description: "Numeric keys only - enforced on write." },
    max: { type: "integer", description: "Numeric keys only, when bounded - enforced on write." },
    liveValue: { description: "Keys applied only at startup (pool.*, security.trust_proxy): the value in use now - differs from the stored one until a restart." },
  }, ["key", "label", "description", "default"]),
  SettingsGroupSchema: object({
    group: object({ label: { type: "string" }, description: { type: "string" } }),
    fields: arrayOf(ref("SettingField")),
  }),
  SettingsIndex: object({
    groups: { type: "object", additionalProperties: object({ label: { type: "string" }, description: { type: "string" } }) },
    fields: arrayOf(object({
      key: { type: "string" },
      group: { type: "string" },
      label: { type: "string" },
      description: { type: "string" },
      section: { type: "string" },
    }, ["key", "group", "label", "description"])),
  }),
  MaintenanceTable: object({
    oid: { type: "integer" },
    schema: { type: "string" },
    name: { type: "string" },
    kind: { type: "string", enum: ["TABLE", "PARTITIONED_TABLE", "MATERIALIZED_VIEW"] },
    totalBytes: { type: "integer", description: "Table, indexes and TOAST together." },
    tableBytes: { type: "integer" },
    indexBytes: { type: "integer" },
    toastBytes: { type: "integer" },
    estimatedRows: { type: ["integer", "null"], description: "The planner's estimate; null until first analyzed." },
    liveRows: { type: ["integer", "null"] },
    deadRows: { type: ["integer", "null"], description: "Rows VACUUM can reclaim." },
    lastVacuum: nullable(DATE_TIME),
    lastAutovacuum: nullable(DATE_TIME),
    lastAnalyze: nullable(DATE_TIME),
    lastAutoanalyze: nullable(DATE_TIME),
    owner: { type: "string" },
    canMaintain: { type: "boolean", description: "The configured role owns it, or holds MAINTAIN (PostgreSQL 17+)." },
    invalidIndexes: arrayOf({ type: "integer" }),
  }),
  MaintenanceIndex: object({
    oid: { type: "integer" },
    name: { type: "string" },
    bytes: { type: "integer" },
    scans: { type: "integer", description: "Index scans since the statistics were last reset." },
    primary: { type: "boolean" },
    unique: { type: "boolean" },
    valid: { type: "boolean", description: "False after a failed concurrent build - unused until rebuilt or dropped." },
    definition: { type: "string" },
  }),
  MaintenanceRun: object({
    id: UUID,
    operation: { type: "string", enum: ["VACUUM", "ANALYZE", "REINDEX"] },
    tableOid: { type: "integer" },
    indexOid: { type: ["integer", "null"] },
    label: { type: "string", description: "schema.table (or schema.index) when queued." },
    status: { type: "string", enum: ["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"] },
    progress: {
      type: ["object", "null"],
      description: "While running: PostgreSQL's own phase and, when measurable, percent.",
      properties: { phase: { type: "string" }, percent: { type: ["integer", "null"] } },
    },
    error: { type: ["string", "null"] },
    batchId: { type: ["string", "null"], format: "uuid" },
    queuedBy: UUID,
    createdAt: DATE_TIME,
    startedAt: nullable(DATE_TIME),
    completedAt: nullable(DATE_TIME),
  }),
  MaintenanceBatch: object({
    id: UUID,
    operation: { type: "string", enum: ["VACUUM", "ANALYZE", "REINDEX"] },
    active: { type: "boolean", description: "Some target still pending or running." },
    total: { type: "integer" },
    done: { type: "integer" },
    failed: { type: "integer" },
    cancelled: { type: "integer" },
    pending: { type: "integer" },
    current: {
      type: ["object", "null"],
      description: "The target running now, with PostgreSQL's own progress.",
      properties: {
        label: { type: "string" },
        progress: { type: ["object", "null"], properties: { phase: { type: "string" }, percent: { type: ["integer", "null"] } } },
      },
    },
    startedBy: UUID,
    createdAt: DATE_TIME,
    items: arrayOf(object({
      id: UUID,
      tableOid: { type: "integer" },
      indexOid: { type: ["integer", "null"] },
      label: { type: "string" },
      status: { type: "string", enum: ["PENDING", "RUNNING", "DONE", "FAILED", "CANCELLED"] },
      error: { type: ["string", "null"] },
      startedAt: nullable(DATE_TIME),
      completedAt: nullable(DATE_TIME),
    })),
  }),
  MaintenanceOverview: object({
    database: { type: "string" },
    version: { type: "string" },
    sizeBytes: { type: "integer" },
    tables: arrayOf(ref("MaintenanceTable")),
  }),
  AdminProfile: object({
    id: UUID,
    email: { type: "string", format: "email" },
    name: nullable({ type: "string" }),
    avatarUrl: nullable({ type: "string" }),
    active: { type: "boolean" },
    access: { type: "string", enum: ["ADMIN", "APP"] },
  }),
};
