import { generateTemplatePdf } from "@totalbase/templates";
import { describe, expect, it } from "vitest";
import { PDF_TEMPLATE_EXAMPLE, PDF_TEMPLATE_EXAMPLE_DATA, PDF_TEMPLATES } from "./guides-pdf.js";

// Designing a PDF without the visual designer meant reading pdfme's source (MCP_Demo_Findings.md F24): the guide's
// example is rendered here, so it can't stop working unnoticed.
describe("totalbase://guide/pdf-templates", () => {
  it("renders its example with its data", async () => {
    const pdf = await generateTemplatePdf(PDF_TEMPLATE_EXAMPLE, PDF_TEMPLATE_EXAMPLE_DATA);
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("shows the example it renders", () => {
    expect(PDF_TEMPLATES).toContain(JSON.stringify(PDF_TEMPLATE_EXAMPLE));
    expect(PDF_TEMPLATES).toContain(JSON.stringify(PDF_TEMPLATE_EXAMPLE_DATA));
  });
});
