import { generate } from "@pdfme/generator";
import {
  barcodes,
  checkbox,
  circleMark,
  date,
  dateTime,
  ellipse,
  image,
  line,
  list,
  multiVariableText,
  radioGroup,
  rectangle,
  select,
  signature,
  svg,
  table,
  text,
  time,
} from "@pdfme/schemas";
import type { Template } from "@pdfme/common";
import { TotalBaseError } from "@totalbase/errors";

// Every field type PdfTemplateDesigner.vue's admin UI lets a template
// designer place - this side of the fence has to know how to render the
// exact same set, or a template saved with (say) a table or checkbox
// field would build fine in the designer and then fail here at actual
// PDF-generation time. Keep in sync with that component's `plugins` map.
const PLUGINS = {
  text,
  multiVariableText,
  table,
  list,
  line,
  rectangle,
  ellipse,
  image,
  svg,
  signature,
  select,
  checkbox,
  radioGroup,
  circleMark,
  date,
  time,
  dateTime,
  qrcode: barcodes.qrcode,
  code128: barcodes.code128,
  ean13: barcodes.ean13,
  upca: barcodes.upca,
};

/**
 * Renders a kind='PDF' totalbase.templates row (its `content` column, a
 * pdfme Template - basePdf + positioned schemas) against one set of input
 * values into a PDF buffer. pdfme's fields take strings - a table's rows and a
 * multi-variable text's variables are JSON text - so any other value is
 * JSON-stringified here, the same for every caller (the PDF route, a
 * workflow's Generate PDF steps).
 */
export async function generateTemplatePdf(
  content: unknown,
  inputs: Record<string, unknown>,
): Promise<Buffer> {
  try {
    const pdf = await generate({
      template: content as Template,
      inputs: [toStringInputs(inputs)],
      plugins: PLUGINS,
    });
    return Buffer.from(pdf);
  } catch (error) {
    throw new TotalBaseError(
      "TEMPLATE_PDF_GENERATION_FAILED",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function toStringInputs(inputs: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputs)) {
    result[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return result;
}

/**
 * Sample inputs for previewing a PDF template: every input field's own
 * `content` - the placeholder value the designer shows on its canvas (a
 * table's is its JSON rows). pdfme renders a missing input as an empty
 * field, so without this a preview would show only the fixed labels.
 * `readOnly` fields are fixed content, not inputs, and are skipped. Accepts
 * both schema shapes pdfme has used: one array of named fields per page, and
 * the older one object keyed by field name per page.
 */
export function samplePdfInputs(content: unknown): Record<string, string> {
  const inputs: Record<string, string> = {};
  const pages = (content as { schemas?: unknown } | null)?.schemas;
  if (!Array.isArray(pages)) return inputs;
  for (const page of pages) {
    const fields: Array<[string | undefined, unknown]> = Array.isArray(page)
      ? page.map((field) => [(field as { name?: string } | null)?.name, field])
      : Object.entries((page ?? {}) as Record<string, unknown>);
    for (const [name, field] of fields) {
      const schema = field as { readOnly?: boolean; content?: unknown } | null;
      if (!name || !schema || schema.readOnly || typeof schema.content !== "string") continue;
      inputs[name] = schema.content;
    }
  }
  return inputs;
}
