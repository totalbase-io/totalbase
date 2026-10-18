import { UUID_PATTERN } from "@totalbase/shared";
import { TotalBaseError } from "@totalbase/errors";
import { assertTemplateReadAllowed } from "@totalbase/mutations";
import { generateTemplatePdf } from "@totalbase/templates";
import type { OperationHandler } from "./types.js";

/** Inline pdfme design (no saved Templates-module record) - GeneratePdfModal.vue's own doc comment: no visual-designer reuse yet, raw JSON design. */
const generatePdf: OperationHandler = async ({ configuration }) => {
  const design = configuration.design as Record<string, unknown> | undefined;
  if (!design) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This step has no PDF design configured.");
  const pdf = await generateTemplatePdf(design, (configuration.data as Record<string, unknown> | undefined) ?? {});
  return { output: "next", result: { mimeType: "application/pdf", content: pdf.toString("base64") } };
};


/**
 * A saved kind='PDF' template, by id (Specification_Workflows.md §5.22). Rendering
 * is reading: the executor needs READ on that templates row (its row
 * filter included), as on the PDF route - TEMPLATE_ACCESS_DENIED otherwise.
 */
const generatePdfTemplate: OperationHandler = async ({ context, dataPrincipal, configuration }) => {
  const templateId = configuration.template;
  if (templateId === undefined || templateId === null || templateId === "") throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This step has no template configured.");
  if (typeof templateId !== "string" || !UUID_PATTERN.test(templateId)) throw new TotalBaseError("TEMPLATE_NOT_FOUND", `Template not found: ${String(templateId)}`);
  await assertTemplateReadAllowed(context, dataPrincipal, templateId);
  const template = await context.templatesAdmin.get(templateId);
  if (template.kind !== "PDF") throw new TotalBaseError("TEMPLATE_WRONG_KIND", `Template "${template.name}" is not a PDF template.`);
  const pdf = await generateTemplatePdf(template.content, (configuration.data as Record<string, unknown> | undefined) ?? {});
  return { output: "next", result: { mimeType: "application/pdf", content: pdf.toString("base64") } };
};

export const DOCUMENT_HANDLERS: Record<string, OperationHandler> = {
  "totalbase.generate-pdf": generatePdf,
  "totalbase.generate-pdf-template": generatePdfTemplate,
};
