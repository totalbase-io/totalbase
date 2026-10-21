import { describe, expect, it } from "vitest";
import { COLUMN_PRESENTATION_KEYS, columnPresentationOptions, columnTitle, pickColumnPresentation, templateColumns, validateColumnPresentation, validateRowPresentation } from "./column-presentation.js";

describe("validateColumnPresentation", () => {
  it("keeps what is set, trimmed, and leaves empty text out", () => {
    const { presentation, errors } = validateColumnPresentation(
      { label: "  Precio unitario ", description: "", displayFormat: "#,##0.00;(#,##0.00)", emptyText: "  " },
      "number",
    );
    expect(errors).toEqual([]);
    expect(presentation).toEqual({ label: "Precio unitario", displayFormat: "#,##0.00;(#,##0.00)" });
  });

  it("refuses an option the column's type doesn't take", () => {
    expect(validateColumnPresentation({ displayFormat: "dd/MM/yyyy" }, "text").errors).toEqual(["Format doesn't apply to a text column."]);
    expect(validateColumnPresentation({ booleanLabels: { true: "Yes" } }, "number").errors).toEqual([
      "True and false labels doesn't apply to a number column.",
    ]);
    expect(validateColumnPresentation({ linkType: "url" }, "date").errors).toEqual(["Link doesn't apply to a date column."]);
  });

  it("takes each option on its own type", () => {
    expect(validateColumnPresentation({ displayFormat: "dd/MM/yyyy HH:mm" }, "timestamp").presentation).toEqual({ displayFormat: "dd/MM/yyyy HH:mm" });
    expect(validateColumnPresentation({ booleanLabels: { true: "Active", false: "" } }, "boolean").presentation).toEqual({
      booleanLabels: { true: "Active" },
    });
    expect(validateColumnPresentation({ linkType: "email" }, "text").presentation).toEqual({ linkType: "email" });
  });

  it("refuses unknown keys - a validation rule is PostgreSQL's, not presentation", () => {
    expect(validateColumnPresentation({ min: 0, label: "Price" }, "number").errors).toEqual([`Unknown option "min" - one of: ${COLUMN_PRESENTATION_KEYS.join(", ")}.`]);
  });

  it("refuses wrong types, too long text and control characters", () => {
    expect(validateColumnPresentation({ label: 7 }, "text").errors).toEqual(["Label must be text."]);
    expect(validateColumnPresentation({ label: "x".repeat(65) }, "text").errors).toEqual(["Label is longer than 64 characters."]);
    expect(validateColumnPresentation({ label: "a\u0000b" }, "text").errors).toEqual(["Label has a control character."]);
    expect(validateColumnPresentation({ linkType: "ftp" }, "text").errors).toEqual(["Link is one of: url, email, tel."]);
    expect(validateColumnPresentation([], "text").errors).toEqual(["The presentation must be an object."]);
  });

  it("keeps how each CHECK value shows, leaving out the empty ones", () => {
    const { presentation, errors } = validateColumnPresentation(
      { options: { A: { label: " Activo ", color: "success", icon: "i-lucide-check" }, I: { label: "", color: "" } } },
      "text",
    );
    expect(errors).toEqual([]);
    expect(presentation).toEqual({ options: { A: { label: "Activo", color: "success", icon: "i-lucide-check" } } });
  });

  it("refuses a value's color outside the theme, an unknown setting and a bad icon", () => {
    expect(validateColumnPresentation({ options: { A: { color: "#ff0000" } } }, "text").errors).toEqual([
      'The color of "A" is one of: primary, secondary, success, info, warning, error, neutral.',
    ]);
    expect(validateColumnPresentation({ options: { A: { weight: "bold" } } }, "text").errors).toEqual(['Unknown option setting "weight" on "A".']);
    expect(validateColumnPresentation({ options: { A: { icon: "<svg>" } } }, "text").errors).toEqual([
      'The icon of "A" isn\'t an icon name (i-lucide-mail).',
    ]);
  });

  it("keeps help, a placeholder and an icon - trailing only when asked, and only with an icon", () => {
    expect(
      validateColumnPresentation({ help: "Sin guiones", placeholder: "20-12345678-9", icon: "i-lucide-id-card", iconPosition: "leading" }, "text").presentation,
    ).toEqual({ help: "Sin guiones", placeholder: "20-12345678-9", icon: "i-lucide-id-card" });
    expect(validateColumnPresentation({ icon: "i-lucide-percent", iconPosition: "trailing" }, "number").presentation).toEqual({
      icon: "i-lucide-percent",
      iconPosition: "trailing",
    });
    expect(validateColumnPresentation({ iconPosition: "trailing" }, "number").presentation).toEqual({});
    expect(validateColumnPresentation({ icon: "i-lucide-x", iconPosition: "end" }, "number").errors).toEqual(["Icon position is leading or trailing."]);
  });

  it("gives a boolean neither a placeholder nor an icon", () => {
    expect(validateColumnPresentation({ placeholder: "x", icon: "i-lucide-check" }, "boolean").errors).toEqual([
      "Placeholder doesn't apply to a boolean column.",
      "Icon doesn't apply to a boolean column.",
    ]);
  });
});

describe("validateColumnPresentation's cell style", () => {
  it("keeps how its cells look, on any type - false and empty are unset", () => {
    expect(
      validateColumnPresentation({ align: "left", fontSize: "lg", bold: true, italic: false, mono: true, color: "emerald" }, "boolean").presentation,
    ).toEqual({ align: "left", fontSize: "lg", bold: true, mono: true, color: "emerald" });
  });

  it("refuses values outside its lists", () => {
    expect(validateColumnPresentation({ align: "justify", fontSize: "xl", color: "primary", bold: "yes" }, "text").errors).toEqual([
      "Alignment is one of: left, center, right.",
      "Font size is one of: xs, sm, base, lg.",
      "Color is one of: red, orange, amber, yellow, lime, green, emerald, teal, cyan, sky, blue, indigo, violet, purple, fuchsia, pink, rose.",
      "Bold is true or false.",
    ]);
  });
});

describe("pickColumnPresentation", () => {
  it("reads only the presentation of a stored config", () => {
    expect(pickColumnPresentation({ label: "Price", min: 0, step: 2, linkType: "url" })).toEqual({ label: "Price", linkType: "url" });
    expect(pickColumnPresentation(null)).toEqual({});
  });
});

describe("columnPresentationOptions", () => {
  it("offers a format for numbers and dates, labels for booleans, a link for text", () => {
    expect(columnPresentationOptions("number")).toEqual({ displayFormat: true, booleanLabels: false, linkType: false, placeholder: true, icon: true });
    expect(columnPresentationOptions("boolean")).toEqual({ displayFormat: false, booleanLabels: true, linkType: false, placeholder: false, icon: false });
    expect(columnPresentationOptions("text")).toEqual({ displayFormat: false, booleanLabels: false, linkType: true, placeholder: true, icon: true });
    expect(columnPresentationOptions("relation")).toEqual({ displayFormat: false, booleanLabels: false, linkType: false, placeholder: true, icon: true });
  });
});

describe("validateRowPresentation()", () => {
  const columns = ["id", "name", "code"];
  it("keeps a known column and a template naming known columns; {} clears", () => {
    expect(validateRowPresentation({ displayField: "name", displayTemplate: " {{code}} - {{name}} " }, columns))
      .toEqual({ presentation: { displayField: "name", displayTemplate: "{{code}} - {{name}}" }, errors: [] });
    expect(validateRowPresentation({}, columns)).toEqual({ presentation: {}, errors: [] });
  });
  it("names an unknown column, a template without columns and an unknown key", () => {
    expect(validateRowPresentation({ displayField: "nope" }, columns).errors).toEqual(['The table has no column "nope".']);
    expect(validateRowPresentation({ displayTemplate: "{{code}} {{nope}}" }, columns).errors).toEqual(['The table has no column "nope".']);
    expect(validateRowPresentation({ displayTemplate: "plain" }, columns).errors).toHaveLength(1);
    expect(validateRowPresentation({ avatar: "x" }, columns).errors).toEqual(['Unknown option "avatar".']);
  });
  it("lists a template's columns in order", () => {
    expect(templateColumns("{{ code }} ({{name}})")).toEqual(["code", "name"]);
  });
});

// DataViews.md §15.7: conditions - their shape here, their filters by the server's parser.
describe("validateColumnPresentation() - conditions", () => {
  it("keeps named conditions with their filter, where and look, and the new cell styles", () => {
    const { presentation, errors } = validateColumnPresentation({
      underline: true,
      background: "amber",
      conditions: [
        { name: "Out", where: { stock: { _lte: "0" } }, style: { color: "red", icon: "i-lucide-triangle-alert", badge: true } },
        { name: "Void", enabled: false, applyTo: "row", where: { estado: { _eq: "ANULADA" } }, style: { strike: true, dim: true } },
      ],
    }, "number");
    expect(errors).toEqual([]);
    expect(presentation.underline).toBe(true);
    expect(presentation.background).toBe("amber");
    expect(presentation.conditions).toEqual([
      { name: "Out", where: { stock: { _lte: "0" } }, style: { color: "red", icon: "i-lucide-triangle-alert", badge: true } },
      { name: "Void", enabled: false, where: { estado: { _eq: "ANULADA" } }, applyTo: "row", style: { strike: true, dim: true } },
    ]);
  });

  it("refuses a condition without a name or a filter, a repeated name, a free color", () => {
    const { errors } = validateColumnPresentation({
      conditions: [
        { where: { a: { _eq: "1" } }, style: {} },
        { name: "X", where: {}, style: {} },
        { name: "Y", where: { a: { _eq: "1" } }, style: { color: "#ff0000" } },
        { name: "y", where: { a: { _eq: "2" } }, style: {} },
      ],
    }, "text");
    expect(errors.join(" ")).toMatch(/needs a name/);
    expect(errors.join(" ")).toMatch(/needs a filter/);
    expect(errors.join(" ")).toMatch(/Color is one of/);
    expect(errors.join(" ")).toMatch(/used twice/);
  });
});

describe("short label", () => {
  it("keeps a short label within 32 characters", () => {
    expect(validateColumnPresentation({ label: "Cantidad pedida", shortLabel: " Cant. " }, "number").presentation).toEqual({ label: "Cantidad pedida", shortLabel: "Cant." });
    expect(validateColumnPresentation({ shortLabel: "x".repeat(33) }, "text").errors).toEqual(["Short label is longer than 32 characters."]);
  });

  it("titles a list's header by it, everything else by the label - the name when neither", () => {
    expect(columnTitle({ label: "Cantidad pedida", shortLabel: "Cant." }, "Cantidad", { short: true })).toBe("Cant.");
    expect(columnTitle({ label: "Cantidad pedida", shortLabel: "Cant." }, "Cantidad")).toBe("Cantidad pedida");
    expect(columnTitle({ label: "Cantidad pedida" }, "Cantidad", { short: true })).toBe("Cantidad pedida");
    expect(columnTitle(undefined, "Cantidad", { short: true })).toBe("Cantidad");
  });
});
