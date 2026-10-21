import type { FastifyInstance } from "fastify";
import { generateTemplatePdf, getTemplate } from "@totalbase/templates";
import { TotalBaseError } from "@totalbase/errors";
import type { AppContext } from "../context.js";
import { canOnTotalbaseResource } from "../openapi-docs.js";
import { extractBearerToken } from "../auth-guards.js";
import { resolveDataPrincipal } from "../data-principal.js";
import { assertTemplateReadAllowed } from "@totalbase/mutations";

/**
 * Rendering a PDF over totalbase.templates is reading it
 * (Administration.md §9.4): READ on the template within the
 * grant's row filter, checked by @totalbase/mutations'
 * assertTemplateReadAllowed - the same check, and the same
 * TEMPLATE_ACCESS_DENIED, as the workflow steps that render templates.
 * MAILING templates are sent by the workflow Send email operation, not by a
 * route of their own.
 */
export function registerTemplatesRoutes(app: FastifyInstance, context: AppContext): void {
  app.post<{ Params: { id: string }; Body: { data?: Record<string, unknown> } | null }>(
    "/api/totalbase/table/templates/:id/pdf",
    {
      config: {
        openapi: {
          summary: "Render a PDF template",
          description: "`data`'s values fill the template's fields, by name - a table's rows (`string[][]`) or a multi-variable text's variables (an object) as JSON or as its JSON text. Requires READ on the template.",
          tags: ["templates"],
          access: "principal",
          pathParameters: { id: { schema: { type: "string", format: "uuid" } } },
          requestBody: {
            required: false,
            schema: { type: "object", properties: { data: { type: "object", additionalProperties: true, description: "Field name -> value; a value that isn't a string is sent to the field as its JSON text." } } },
          },
          response: { status: "200", contentType: "application/pdf", schema: { type: "string", format: "binary" } },
          visible: canOnTotalbaseResource(context, "templates", "READ"),
        },
      },
    },
    async (request, reply) => {
      const dataPrincipal = await resolveDataPrincipal(context, extractBearerToken(request), undefined, request);
      await assertTemplateReadAllowed(context, dataPrincipal, request.params.id);

      const template = await getTemplate(context.database, request.params.id);
      if (template.kind !== "PDF") {
        throw new TotalBaseError("TEMPLATE_WRONG_KIND", `Template ${template.id} is not a PDF template.`);
      }

      const values = request.body?.data;
      const pdf = await generateTemplatePdf(template.content, typeof values === "object" && values !== null && !Array.isArray(values) ? values : {});
      reply.header("content-type", "application/pdf");
      reply.header("content-disposition", `inline; filename="${encodeURIComponent(template.slug)}.pdf"`);
      return reply.send(pdf);
    },
  );
}
