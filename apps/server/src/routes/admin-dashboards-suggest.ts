import type { FastifyInstance } from "fastify";
import { suggestDashboard } from "@totalbase/dashboards";
import { dataEnvelope, type JsonSchema } from "@totalbase/openapi";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth-guards.js";
import { adminDoc, arrayOf, object, ok } from "../openapi-admin-docs.js";
import { type DataBody, requestData } from "../request-body.js";

interface SuggestBody {
  name: string;
  schema?: string | null;
}

/** A decision (Specification_Dashboards.md §5.19, DM3): a fixed code, its sentence in the App's language, what was read. */
const DECISION: JsonSchema = object({
  code: { type: "string", description: "Fixed, kebab-case - one of the decision codes (totalbase://guide/dashboards, Reasons)." },
  message: { type: "string", description: "In the App's language (system.language)." },
  detail: { type: "string", description: "What was read: a type, a constraint, a pg_stats value - never translated." },
}, ["code", "message"]);

const SPEC: JsonSchema = {
  type: "object",
  additionalProperties: true,
  description: "A dashboard in the DashboardSpec shape (§8.3) - name, description, icon, variables, widgets [{type, label, query, config}] - with no ids, every role set in config.roles; applied as is with apply_dashboard.",
};
const WIDGETS: JsonSchema = arrayOf({ type: "object", additionalProperties: true, description: "A widget in the spec's shape: {type, label, query, config}." });

const SUGGESTION: JsonSchema = object({
  relation: object({
    schema: { type: "string" },
    name: { type: "string" },
    type: { type: "string", enum: ["TABLE", "VIEW"] },
    resourceId: { type: ["string", "null"], format: "uuid" },
  }),
  analysis: arrayOf(object({
    column: { type: "string" },
    role: { type: "string", enum: ["moment", "deadline", "measure", "category", "dimension", "identifier", "place", "file", "discarded"] },
    reason: DECISION,
    alternatives: arrayOf({ type: "string" }),
    origin: { type: "string", description: "A view's column: the table column whose role it took (schema.table.column)." },
    aggregate: { type: "string", enum: ["sum", "avg"] },
    values: arrayOf({ type: "string" }),
    references: { type: "string", description: "A dimension's or a file's target table (schema.table)." },
  }, ["column", "role", "reason"])),
  spec: SPEC,
  more: { ...WIDGETS, description: "Widgets offered unticked, in the spec's shape - added to spec.widgets to apply them." },
  reasons: arrayOf(object({ path: { type: "string", description: "widgets[i], more[i], variables[i] or columns.<name>." }, reason: DECISION })),
  missing: arrayOf(DECISION),
  security: object({
    notice: DECISION,
    options: arrayOf(object({
      key: { type: "string", enum: ["openOnViewers", "onlyViewers"] },
      column: { type: "string" },
      field: { type: "string", description: "The column of users with a foreign key to the dimension's table." },
      reason: DECISION,
      spec: SPEC,
      more: WIDGETS,
    })),
  }),
});

/**
 * The dashboard assistant (Specification_Dashboards.md §10.7, D27) - administrators only, like the rest of
 * /admin/api/dashboards: one table or view read from the catalog and pg_stats (never its rows) and a dashboard
 * proposed for it. Nothing is created: the spec is applied with apply_dashboard.
 */
export function registerAdminDashboardsSuggestRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAdmin(context);

  app.post<{ Body: DataBody<SuggestBody> }>("/admin/api/dashboards/suggest", {
    preHandler,
    ...adminDoc("dashboards", {
      summary: "Suggest a dashboard for a table or view",
      description:
        "Reads one table or view - its types, constraints, foreign keys, a view's origins, pg_stats and pg_class.reltuples, never its rows - and proposes a dashboard: each column's role with its reason (analysis), the dashboard (spec, every role set), the widgets offered unticked (more), what's missing, and the security notice with its options. Messages are in the App's language (system.language); codes and details never change with it. Nothing is applied. 404 RESOURCE_NOT_FOUND for an unknown table or view.",
      requestBody: { schema: dataEnvelope(object({ name: { type: "string", description: "The table or view." }, schema: { type: ["string", "null"], description: "Default public." } }, ["name"])) },
      response: ok(SUGGESTION),
    }),
  }, async (request) => {
    const body = requestData(request.body);
    const language = await context.settings.get("system.language");
    return { data: await suggestDashboard(context.database, { name: typeof body.name === "string" ? body.name : "", schema: typeof body.schema === "string" ? body.schema : null, language }) };
  });
}
