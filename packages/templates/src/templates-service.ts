import type { Queryable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";

export type TemplateKind = "MAILING" | "PDF";

export interface TemplateRecord {
  id: string;
  name: string;
  slug: string;
  kind: TemplateKind;
  content: unknown;
}

/**
 * Read-only, kind-agnostic accessor for totalbase.templates - used
 * by what renders a template (the PDF route, the workflow Send email and
 * Generate PDF from template steps), which needs it regardless of kind
 * before checking the kind its engine takes. CRUD is TemplatesAdminService
 * and the Data API.
 */
export async function getTemplate(database: Queryable, id: string): Promise<TemplateRecord> {
  const { rows } = await database.query<TemplateRecord>(
    `SELECT id, name, slug, kind, content FROM totalbase.templates WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) {
    throw new TotalBaseError("TEMPLATE_NOT_FOUND", `Template not found: ${id}`);
  }
  return row;
}
