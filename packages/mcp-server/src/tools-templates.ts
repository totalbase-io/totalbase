import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { slugify } from "@totalbase/shared";
import type { AdminClient } from "./admin-client.js";
import { ADDITIVE, defined, IDEMPOTENT, NAME_RULE, READ_ONLY, result } from "./tool-helpers.js";

/**
 * Templates (Specification_Administration.md §9): rows of
 * templates, written through the Data API like any row - a
 * MAILING template's subject and message with {{placeholders}}, a PDF
 * template's pdfme design - and tried before a workflow uses them.
 */

interface Template { id: string; name: string; slug: string; description: string | null; kind: "MAILING" | "PDF"; content: Record<string, unknown>; default_cc?: string | null; default_bcc?: string | null; default_reply_to?: string | null }

const TEMPLATES = "/totalbase/table/templates";

/** A MAILING template's placeholders - the system emails' grammar: letters, digits, `_` and `.` between double braces. */
export function templatePlaceholders(...texts: unknown[]): string[] {
  const names = new Set<string>();
  for (const text of texts) if (typeof text === "string") for (const [, name] of text.matchAll(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g)) names.add(name!);
  return [...names];
}

/** Whether `data` has a value at a dotted path. */
function hasPath(data: Record<string, unknown>, path: string): boolean {
  let value: unknown = data;
  for (const key of path.split(".")) {
    if (value === null || typeof value !== "object" || !(key in value)) return false;
    value = (value as Record<string, unknown>)[key];
  }
  return value !== undefined && value !== null;
}

const summary = (t: Template) => ({
  id: t.id,
  name: t.name,
  slug: t.slug,
  kind: t.kind,
  description: t.description,
  ...(t.kind === "MAILING" && { placeholders: templatePlaceholders(t.content["subject"], t.content["message"]) }),
});

export function registerTemplateTools(server: McpServer, client: AdminClient): void {
  server.registerTool(
    "list_templates",
    {
      title: "List templates",
      description: "Email (MAILING) and PDF templates: id, name, slug, kind, description and, for an email, the {{placeholders}} its subject and message use - the data a workflow's Send email step must give it.",
      inputSchema: { kind: z.enum(["MAILING", "PDF"]).optional() },
      annotations: READ_ONLY,
    },
    async ({ kind }) => {
      const rows = await client.data<Template[]>("GET", TEMPLATES, { query: { order_by: "name", limit: "500", ...(kind && { "where[kind][_eq]": kind }) } });
      return result(rows.map(summary));
    },
  );

  server.registerTool(
    "save_template",
    {
      title: "Save template",
      description:
        "Create (no id) or update a template. MAILING: subject and message (HTML) with {{placeholders}} - {{name}}, {{order.total}} - filled from the data a workflow's Send email step gives; every placeholder needs a value when it is sent (MISSING_TEMPLATE_VARIABLES), values are HTML-escaped; default_cc / default_bcc / default_reply_to apply where the step leaves them empty. Recipients always come from the step. PDF: content is a pdfme template (base PDF and positioned fields) - usually designed in the admin's PDF designer; here, to copy or adjust one, or to build one after totalbase://guide/pdf-templates (its rules and a complete example). Answers the template and the placeholders it uses.",
      inputSchema: {
        id: z.string().optional().describe("Omit to create"),
        name: z.string().max(32).optional().describe(`Required to create - ${NAME_RULE}`),
        slug: z.string().max(32).optional().describe("URL-safe; proposed from the name when omitted"),
        description: z.string().max(128).nullable().optional(),
        kind: z.enum(["MAILING", "PDF"]).optional().describe("Required to create; never changes"),
        subject: z.string().optional().describe("MAILING"),
        message: z.string().optional().describe("MAILING: the HTML body"),
        content: z.record(z.string(), z.unknown()).optional().describe("PDF: the pdfme template"),
        default_cc: z.string().nullable().optional(),
        default_bcc: z.string().nullable().optional(),
        default_reply_to: z.string().nullable().optional(),
      },
      annotations: ADDITIVE,
    },
    async ({ id, name, slug, description, kind, subject, message, content, default_cc, default_bcc, default_reply_to }) => {
      let body: Record<string, unknown> = defined({ name, slug, description, default_cc, default_bcc, default_reply_to });
      if (subject !== undefined || message !== undefined) {
        // A MAILING content is one jsonb object: a change of either part keeps the other.
        const current = id ? (await client.data<Template>("GET", `${TEMPLATES}/${id}`)).content : {};
        body = { ...body, content: { ...current, ...defined({ subject, message }) } };
      } else if (content !== undefined) body = { ...body, content };
      if (!id) {
        if (!name || !kind) throw new Error("Creating a template needs its name and kind.");
        // As the admin does: the slug proposed from the name (the shared normalization), unless one is given.
        const created = await client.data<Template>("POST", TEMPLATES, { body: { data: { ...body, slug: slug ?? slugify(name), kind } } });
        return result(summary(created));
      }
      return result(summary(await client.data<Template>("PATCH", `${TEMPLATES}/${id}`, { body: { data: body } })));
    },
  );

  server.registerTool(
    "test_template",
    {
      title: "Test template",
      description:
        "Try a template with sample data. PDF: renders it for real (the route a page or a workflow uses) and answers its size - an error names what failed. MAILING: answers its placeholders and which ones the data leaves without a value (a send would fail with MISSING_TEMPLATE_VARIABLES); to see the email itself, run a workflow's Send email step to yourself (run_workflow mode test).",
      inputSchema: {
        id: z.string().describe("The template's id (list_templates)"),
        data: z.record(z.string(), z.unknown()).default({}).describe("Sample values, e.g. {\"name\":\"Ana\",\"order\":{\"total\":120}}"),
      },
      annotations: READ_ONLY,
    },
    async ({ id, data }) => {
      const template = await client.data<Template>("GET", `${TEMPLATES}/${id}`);
      if (template.kind === "PDF") return result({ id, kind: "PDF", ...(await client.binary(`/api/totalbase/table/templates/${id}/pdf`, { data })) });
      const placeholders = templatePlaceholders(template.content["subject"], template.content["message"]);
      const missing = placeholders.filter((p) => !hasPath(data, p));
      return result({ id, kind: "MAILING", placeholders, ...(missing.length > 0 ? { missing } : { complete: true }) });
    },
  );
}
