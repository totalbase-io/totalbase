import { describe, expect, it } from "vitest";
import { generateTemplatePdf, samplePdfInputs } from "./pdf-generator.js";

const basePdf = { width: 210, height: 297, padding: [10, 10, 10, 10] };

describe("generateTemplatePdf", () => {
  it("renders a text field against one input into PDF bytes", async () => {
    const content = {
      basePdf,
      schemas: [
        {
          greeting: { type: "text", position: { x: 20, y: 20 }, width: 100, height: 20, fontSize: 14 },
        },
      ],
    };

    const pdf = await generateTemplatePdf(content, { greeting: "Hola Cesar" });
    expect(pdf).toBeInstanceOf(Buffer);
    expect(pdf.length).toBeGreaterThan(0);
    // %PDF- magic bytes.
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  // The PDF route passed values as they came, so data a workflow step renders failed there
  // ("invalid JSON string '[object Object]'") - every caller now gets the same JSON text (MCP_Demo_Findings.md F22).
  it("sends a value that isn't a string to its field as JSON text", async () => {
    const content = {
      basePdf,
      schemas: [{ total: { type: "text", position: { x: 20, y: 20 }, width: 100, height: 20 } }],
    };
    const pdf = await generateTemplatePdf(content, { total: 715587.5 });
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    await expect(generateTemplatePdf(content, { total: { neto: 1 } })).resolves.toBeInstanceOf(Buffer);
  });

  it("wraps a malformed template into TEMPLATE_PDF_GENERATION_FAILED", async () => {
    await expect(generateTemplatePdf({ not: "a template" }, {})).rejects.toMatchObject({
      code: "TEMPLATE_PDF_GENERATION_FAILED",
    });
  });
});

describe("samplePdfInputs", () => {
  it("takes each input field's own content, skipping readOnly labels (array schema shape)", () => {
    const content = {
      basePdf,
      schemas: [[
        { name: "title", type: "text", content: "INVOICE", readOnly: true },
        { name: "customer_name", type: "text", content: "Globex" },
        { name: "items", type: "table", content: '[["A","1"]]' },
        { name: "rule", type: "line", readOnly: true },
      ]],
    };
    expect(samplePdfInputs(content)).toEqual({ customer_name: "Globex", items: '[["A","1"]]' });
  });

  it("reads the older keyed-object schema shape too", () => {
    const content = { basePdf, schemas: [{ greeting: { type: "text", content: "Hola" } }] };
    expect(samplePdfInputs(content)).toEqual({ greeting: "Hola" });
  });

  it("returns no inputs for a malformed template instead of throwing", () => {
    expect(samplePdfInputs(null)).toEqual({});
    expect(samplePdfInputs({ schemas: "nope" })).toEqual({});
  });

  it("renders a preview where input fields show their sample content", async () => {
    const content = {
      basePdf,
      schemas: [[{ name: "greeting", type: "text", content: "Sample", position: { x: 20, y: 20 }, width: 100, height: 20 }]],
    };
    const pdf = await generateTemplatePdf(content, samplePdfInputs(content));
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });
});
