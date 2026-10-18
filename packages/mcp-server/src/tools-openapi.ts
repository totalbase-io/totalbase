import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AdminClient } from "./admin-client.js";
import { READ_ONLY, result } from "./tool-helpers.js";

/**
 * The generated OpenAPI documents (Specification_Data_API.md §14,
 * Specification_Administration.md §11.3) - TotalBase's own description of
 * its APIs, generated from the catalog, the resources, the permissions and
 * the routes' documentation, never a second endpoint list. Whole documents
 * run to thousands of lines, so the tool answers an index first and the
 * matching operations - with the component schemas they reference - when
 * filtered.
 */

interface OpenApiDocument {
  info?: { title?: string; version?: string };
  paths?: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, unknown> };
}
interface Operation { summary?: string; description?: string; tags?: string[]; operationId?: string; [key: string]: unknown }

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
/** Above this many matching operations the answer stays an index - narrow the filter for the full operations. */
const MAX_FULL = 15;

/** Every `#/components/schemas/X` reachable from a value, transitively. */
function referencedSchemas(value: unknown, schemas: Record<string, unknown>, found = new Map<string, unknown>()): Map<string, unknown> {
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        if (key === "$ref" && typeof child === "string" && child.startsWith("#/components/schemas/")) {
          const name = child.slice("#/components/schemas/".length);
          if (!found.has(name) && schemas[name] !== undefined) {
            found.set(name, schemas[name]);
            visit(schemas[name]);
          }
        } else visit(child);
      }
    }
  };
  visit(value);
  return found;
}

export function registerOpenApiTools(server: McpServer, client: AdminClient): void {
  server.registerTool(
    "get_openapi",
    {
      title: "Get OpenAPI",
      description:
        "TotalBase's generated OpenAPI 3.1 documents - the exact contract of its APIs. api='data': the Data API (/api/*) - every exposed table, view and function with its routes, query parameters and row schema, plus HTTP-triggered workflows and the fixed routes; with role_id, exactly what that role (or an API key holding it) can reach - only its permitted resources, fields and methods: the document to hand a developer or a frontend for that role. api='admin': the Admin API (/admin/api/*) that these tools call. Without path / tag / method it answers an index (method, path, summary, tags); filtered, the full matching operations (parameters, request and response bodies) with the schemas they reference.",
      inputSchema: {
        api: z.enum(["data", "admin"]).default("data"),
        role_id: z.string().optional().describe("api='data' only: the document as this role sees it (list_roles); omitted, as this token sees it - everything"),
        as: z.enum(["user", "api_key"]).optional().describe("With role_id: a signed-in user holding it (default) or an API key holding it (no session-only routes)"),
        path: z.string().optional().describe("Only paths containing this text, e.g. '/public/table/orders' or '/admin/api/dataviews'"),
        tag: z.string().optional().describe("Only operations with this tag (the index lists them)"),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ api, role_id, as, path, tag, method }) => {
      if (api === "admin" && role_id) throw new Error("role_id applies to api='data' only.");
      const document =
        api === "admin"
          ? await client.document<OpenApiDocument>("/admin/api/openapi")
          : role_id
            ? await client.document<OpenApiDocument>("/admin/api/openapi/data", { role: role_id, ...(as && { as }) })
            : await client.document<OpenApiDocument>("/api/openapi.json");

      const matches: { method: string; path: string; operation: Operation }[] = [];
      for (const [route, item] of Object.entries(document.paths ?? {})) {
        if (path && !route.includes(path)) continue;
        for (const verb of METHODS) {
          const operation = item[verb];
          if (!operation) continue;
          if (method && verb !== method.toLowerCase()) continue;
          if (tag && !(operation.tags ?? []).includes(tag)) continue;
          matches.push({ method: verb.toUpperCase(), path: route, operation });
        }
      }

      const filtered = Boolean(path || tag || method);
      const header = { title: document.info?.title, version: document.info?.version, operations: matches.length };
      if (!filtered || matches.length > MAX_FULL) {
        return result({
          ...header,
          ...(filtered && { note: `More than ${MAX_FULL} operations match - narrow path, tag or method to get their full definitions.` }),
          ...(!filtered && { tags: [...new Set(matches.flatMap((m) => m.operation.tags ?? []))].sort() }),
          index: matches.map((m) => `${m.method} ${m.path}${m.operation.summary ? ` - ${m.operation.summary}` : ""}${m.operation.tags?.length ? ` [${m.operation.tags.join(", ")}]` : ""}`),
        });
      }
      const operations = matches.map((m) => ({ method: m.method, path: m.path, ...m.operation }));
      return result({ ...header, paths: operations, schemas: Object.fromEntries(referencedSchemas(operations, document.components?.schemas ?? {})) });
    },
  );
}
