/**
 * totalbase://guide/pdf-templates - what designing a pdfme template without the admin's visual designer takes:
 * the rules learned from pdfme's behavior, and one complete example a test renders
 * (guides-pdf.test.ts), so the example can't stop working unnoticed.
 */

const CELL = {
  alignment: "left",
  verticalAlignment: "middle",
  fontSize: 9,
  lineHeight: 1,
  characterSpacing: 0,
  borderWidth: { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 },
  padding: { top: 2, right: 2, bottom: 2, left: 2 },
};

/** An invoice page: a bold title, the issuer, the lines table, a total and a QR - A4, in millimeters. */
export const PDF_TEMPLATE_EXAMPLE = {
  basePdf: { width: 210, height: 297, padding: [0, 0, 0, 0] },
  schemas: [
    [
      { name: "titulo", type: "text", readOnly: true, textFormat: "inline-markdown", content: "**FACTURA** A", position: { x: 15, y: 12 }, width: 90, height: 10, fontSize: 18 },
      {
        name: "emisor",
        type: "multiVariableText",
        textFormat: "inline-markdown",
        text: "**{razon_social}**\nCUIT {cuit}",
        variables: ["razon_social", "cuit"],
        content: "{}",
        position: { x: 15, y: 25 },
        width: 90,
        height: 14,
        fontSize: 10,
      },
      {
        name: "lineas",
        type: "table",
        position: { x: 15, y: 50 },
        width: 180,
        height: 185,
        showHead: true,
        head: ["Producto", "Cant.", "Precio", "Importe"],
        headWidthPercentages: [52, 12, 18, 18],
        tableStyles: { borderColor: "#000000", borderWidth: 0.3 },
        headStyles: { ...CELL, fontColor: "#ffffff", backgroundColor: "#333333", borderColor: "" },
        bodyStyles: { ...CELL, fontColor: "#000000", backgroundColor: "", borderColor: "#888888", alternateBackgroundColor: "#f5f5f5" },
        columnStyles: {},
        content: "[]",
      },
      { name: "total", type: "text", alignment: "right", content: "", position: { x: 135, y: 240 }, width: 60, height: 8, fontSize: 12 },
      { name: "qr", type: "qrcode", content: "https://example.com", position: { x: 15, y: 245 }, width: 30, height: 30 },
    ],
  ],
};

/** The data a workflow's Generate PDF step (or test_template) fills it with. */
export const PDF_TEMPLATE_EXAMPLE_DATA = {
  emisor: { razon_social: "Empresa Ejemplo SA", cuit: "30-71234567-9" },
  lineas: [["Producto 1", "2", "1.000,00", "2.000,00"], ["Producto 2", "1", "500,00", "500,00"]],
  total: "$ 2.500,00",
  qr: "https://example.com/invoice/1",
};

export const PDF_TEMPLATES = `# PDF templates

A PDF template (save_template kind PDF) is a pdfme template: \`basePdf\` (a blank page's size and padding, in millimeters - or a PDF to write on) and \`schemas\`, one list of fields per page, each positioned in millimeters from the page's top left. A field's \`name\` is the key its value comes in by - a workflow's Generate PDF step's data, test_template's data. The admin's PDF designer draws the same JSON.

## Rules pdfme keeps
- A field with \`readOnly: true\` is fixed content - its \`content\` is printed, no value is read for it (a title, a label).
- Bold and italics (\`textFormat: "inline-markdown"\`, \`**bold**\`, \`*italic*\`) work on a readOnly text and on a multiVariableText - not on an input text field, which prints the asterisks.
- multiVariableText: \`text\` with {variables}, \`variables\` naming them; its value is an object of them ({"razon_social": "...", "cuit": "..."}) - TotalBase sends it to pdfme as its JSON text.
- table: \`head\` and \`headWidthPercentages\` (summing to 100), \`tableStyles\`, \`headStyles\`, \`bodyStyles\` and \`columnStyles\` all present (pdfme fails on a missing one - copy them from the example); its value is the rows, a list of lists of text ([["Producto 1", "2", "1.000,00"]]).
- **A table pushes down what is below it** by as much as it grows past its \`height\` - a total placed under a table of 20 mm lands on page 2 once the lines need 180 mm. Give the table the height of the space it may fill (here 185 mm, to y 235) and place what follows below that. More lines than fit continue the table on a new page, with what follows it after them.
- Values are text: a number or a date is formatted before it reaches the template (in the SQL or the workflow step). qrcode, code128 and ean13 take their text as the code.
- test_template renders it for real and answers its size; it doesn't show the page - check the layout by opening the template in the admin's PDF designer, or by rendering with as many lines as the longest real document.

## A complete example (one A4 page: title, issuer, lines, total, QR)
\`\`\`json
${JSON.stringify(PDF_TEMPLATE_EXAMPLE)}
\`\`\`
Its data:
\`\`\`json
${JSON.stringify(PDF_TEMPLATE_EXAMPLE_DATA)}
\`\`\``;
