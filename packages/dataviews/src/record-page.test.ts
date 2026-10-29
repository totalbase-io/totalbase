import { validateVariables, validateWidgetControlConfig } from "@totalbase/tb-catalog";
import { describe, expect, it } from "vitest";
import { generateRecordPage, variableNameFor, type GeneratedWidget } from "./record-page.js";

const COLUMNS = [
  { name: "razon_social", label: "Razón social", widget: "UInput" as const },
  { name: "cliente", label: "Cliente", widget: "USelectMenu" as const, options: { resource: "r-clientes", valueKey: "id", labelKey: "razon_social", variable: "clientes" } },
  { name: "fecha", label: "Fecha", widget: "UInputDate" as const },
];

function all(widgets: readonly GeneratedWidget[]): GeneratedWidget[] {
  return widgets.flatMap((w) => [w, ...all(Object.values(w.slots ?? {}).flat())]);
}

describe("generateRecordPage()", () => {
  it("makes a FORM a form over the record: a field per column, its select fed by a Resource - no Save, its frame's footer has it", () => {
    const page = generateRecordPage({ type: "FORM", columns: COLUMNS });
    const form = page.widgets[0]!;
    expect(form).toMatchObject({ widget: "UForm", name: "form" });
    const children = form.slots!.default!;
    expect(children.map((c) => c.widget)).toEqual(["UFormField", "UFormField", "UFormField"]);
    expect(children[1]).toMatchObject({ props: { column: "cliente", label: "Cliente" }, width: 12 });
    expect(children[1]!.slots!.default![0]).toMatchObject({ widget: "USelectMenu", props: { valueKey: "id", labelKey: "razon_social" }, bindings: { items: { kind: "variable", variable: "clientes" } } });
    expect(page.variables).toEqual([
      { name: "clientes", kind: "RESOURCE", resource: "r-clientes", query: { fields: "id,razon_social", order_by: "razon_social", limit: 100 }, mode: "list", immediate: true, watch: false, count: false },
    ]);
    expect(page.code).toBe("");
  });

  it("shows a foreign key's row template in full in its select, its Resource reading every column of it (B46)", () => {
    const columns = [{ name: "producto", label: "Producto", widget: "USelectMenu" as const, options: { resource: "r-productos", valueKey: "id", labelKey: "codigo", variable: "productos", template: "{{codigo}} · {{nombre}}" } }];
    const page = generateRecordPage({ type: "FORM", columns });
    const select = page.widgets[0]!.slots!.default![0]!.slots!.default![0]!;
    expect(select.props).toEqual({ valueKey: "id", labelKey: "codigo" });
    expect(select.bindings).toMatchObject({ items: { kind: "variable", variable: "productos" }, labelKey: { kind: "formula" } });
    expect(page.variables[0]!.query).toEqual({ fields: "id,codigo,nombre", order_by: "codigo", limit: 100 });
    expect(validateVariables(page.variables)).toEqual([]);
  });

  it("gives a Master-detail its Detail, rereading the record when its rows change - no Save & New, its frame's footer has it", () => {
    const page = generateRecordPage({ type: "MASTER_DETAIL", columns: COLUMNS, detail: { dataview: "dv-items", column: "factura" } });
    const children = page.widgets[0]!.slots!.default!;
    expect(children.slice(0, 3).every((c) => c.width === 12)).toBe(true);
    expect(children[3]).toMatchObject({ widget: "TDataView", props: { dataview: "dv-items", column: "factura", toolbarMode: "none", paging: false, editInline: true }, emits: { rowsChanged: "onDetailRowsChanged" }, height: 8 });
    expect(children).toHaveLength(4);
    expect(page.code).toContain("await dataview.vars.record.refresh()");
    expect(page.code).not.toContain("onSaveAndNewClick");
  });

  it("gives a grid's record form only its fields - its frame has Save and the record actions", () => {
    const page = generateRecordPage({ type: "GRID", columns: COLUMNS });
    expect(page.widgets[0]!.slots!.default!.map((c) => c.widget)).toEqual(["UFormField", "UFormField", "UFormField"]);
    expect(page.code).toBe("");
    expect(page.variables.map((v) => v.name)).toEqual(["clientes"]);
  });

  it("offers a CHECK list's values in its select, fixed - no Resource", () => {
    const page = generateRecordPage({ type: "GRID", columns: [{ name: "estado", label: "Estado", widget: "USelect", values: ["OPEN", "CLOSED"] }] });
    const select = page.widgets[0]!.slots!.default![0]!.slots!.default![0]!;
    expect(select).toMatchObject({ widget: "USelect", props: { items: ["OPEN", "CLOSED"] } });
    expect(validateWidgetControlConfig({ widget: select.widget, props: select.props, bindings: {}, emits: {} }, [])).toEqual([]);
    expect(page.variables).toEqual([]);
  });

  it("writes what the catalogs accept - every widget config, the variables, code that compiles", () => {
    const page = generateRecordPage({ type: "MASTER_DETAIL", columns: COLUMNS, detail: { dataview: "8981554d-a99d-4aca-a3e7-96c7543b54fa", column: "factura" } });
    const refs = page.variables.map((v) => ({ name: v.name, kind: v.kind }));
    for (const w of all(page.widgets)) {
      expect(validateWidgetControlConfig({ widget: w.widget, props: w.props, bindings: w.bindings ?? {}, emits: w.emits ?? {} }, refs), w.widget).toEqual([]);
    }
    expect(validateVariables(page.variables)).toEqual([]);
     
    expect(() => new Function(page.code)).not.toThrow();
  });

  it("names a table's Resource as a variable - camelCase, never reserved, never twice", () => {
    expect(variableNameFor("tipos_comprobante", [])).toBe("tiposComprobante");
    expect(variableNameFor("clientes", ["clientes"])).toBe("clientes2");
    expect(variableNameFor("record", [])).toBe("recordRows");
    expect(variableNameFor("2024_rates", [])).toBe("rows2024Rates");
  });
});
