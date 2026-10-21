import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AdminClient } from "./admin-client.js";
import { READ_ONLY, result, schemaName } from "./tool-helpers.js";

/**
 * The dashboard assistant (Dashboards.md §10.7, D27) - suggest_presentation's twin for dashboards:
 * reads one table or view from the catalog and pg_stats (never its rows) and proposes a dashboard. Nothing is applied.
 */
export function registerDashboardSuggestTools(server: McpServer, client: AdminClient): void {
  server.registerTool(
    "suggest_dashboard",
    {
      title: "Suggest a dashboard",
      description:
        "Proposes a dashboard for one table or view, from its types, constraints, foreign keys, a view's origins and pg_stats - never its column names, never its rows. Nothing is applied. Returns: analysis (each column's role - moment, deadline, measure, category, dimension, identifier, place, file, discarded - with its reason {code, message, detail} and alternatives); spec (the dashboard in apply_dashboard's shape, every role set in config.roles - a period over the time axis, a list per small dimension, KPIs, ranking, trend, donuts, heatmap, map, latest records); more (widgets offered unticked, same shape - add the wanted ones to spec.widgets); reasons (why each widget and variable, by path); missing (what would make it better - a CHECK on a closed text list, a foreign key on a uuid, ANALYZE); security (the dashboard shows every row: when users points at a dimension's table, options to open on or keep only the viewer's own, each a whole alternative spec). Review it with the user, then apply_dashboard and publish_dashboard.",
      inputSchema: { schema: schemaName(), name: z.string().describe("Table or view name") },
      annotations: READ_ONLY,
    },
    async ({ schema, name }) => result(await client.post("/dashboards/suggest", { data: { name, schema } })),
  );
}
