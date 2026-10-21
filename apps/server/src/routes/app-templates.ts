import type { FastifyInstance, FastifyRequest } from "fastify";
import { generateTemplatePdf, samplePdfInputs } from "@totalbase/templates";
import { TotalBaseError } from "@totalbase/errors";
import type { AppContext } from "../context.js";
import { extractBearerToken, requireAppAccess } from "../auth-guards.js";
import { resolveDataPrincipal, type DataPrincipal } from "../data-principal.js";
import { resolveTableGrant } from "@totalbase/mutations";

const TABLE = "templates";
const DENIED = "ACTION_DENIED";

async function principalOf(context: AppContext, request: FastifyRequest): Promise<DataPrincipal> {
  return resolveDataPrincipal(context, extractBearerToken(request), undefined, request);
}

/**
 * Templates for every portal user (Security.md §9.3 and
 * 10): read and written as Data API rows on templates (the name
 * and slug rules are PostgreSQL CHECKs). What is not a
 * row operation stays here: rendering a PDF preview.
 */
export function registerAppTemplatesRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAppAccess(context);

  // The PDF designer's preview of unsaved content - stores nothing; for someone who may create or edit templates.
  app.post<{ Body: { data?: { content?: unknown } } | undefined }>("/app/api/templates/preview-pdf", { preHandler }, async (request, reply) => {
    const principal = await principalOf(context, request);
    await resolveTableGrant(context, principal, TABLE, "UPDATE", DENIED).catch(() => resolveTableGrant(context, principal, TABLE, "CREATE", DENIED));
    const content = request.body?.data?.content;
    if (!content || typeof content !== "object") throw new TotalBaseError("INVALID_QUERY", "content must be a PDF template object");
    const pdf = await generateTemplatePdf(content, samplePdfInputs(content));
    reply.header("content-type", "application/pdf");
    reply.header("content-disposition", 'inline; filename="preview.pdf"');
    return reply.send(pdf);
  });
}
