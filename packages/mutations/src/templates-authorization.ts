import { TotalBaseError } from "@totalbase/errors";
import type { DataPrincipal } from "./context.js";
import { resolveTableGrant, rowFilterLimits, rowPassesGrant, type TableAuthorizationContext } from "./table-row-authorization.js";

/**
 * Using a template (rendering a PDF, sending a MAILING) is reading it
 * (Specification_Administration.md §9.4): READ on templates within
 * the grant's row filter, through the same resolver as any other table. Used
 * by the workflow steps that render templates (Specification_Workflows.md
 * §5.16, §5.22), as the run's executor; an administrator executor passes.
 */
export async function assertTemplateReadAllowed(context: TableAuthorizationContext, dataPrincipal: DataPrincipal, templateId: string): Promise<void> {
  const grant = await resolveTableGrant(context, dataPrincipal, "templates", "READ", "TEMPLATE_ACCESS_DENIED");
  if (!(await rowPassesGrant(context.database, context, dataPrincipal, grant, templateId, await rowFilterLimits(context)))) {
    throw new TotalBaseError("TEMPLATE_ACCESS_DENIED", "READ is not authorized for this template.");
  }
}
