import { describe, expect, it } from "vitest";
import { newWidgetControlConfig, templateFormula, validateWidgetControlConfig } from "./widget-control.js";
import { itemSlot, slotBase, widgetState } from "./widget-catalog.js";

const VARIABLES = [
  { name: "cliente", kind: "VALUE" },
  { name: "clientes", kind: "RESOURCE" },
] as const;

describe("newWidgetControlConfig()", () => {
  it("starts a widget with a label prop labelled after itself", () => {
    expect(newWidgetControlConfig("UButton")).toEqual({ widget: "UButton", props: { label: "Button" }, bindings: {}, emits: {} });
  });

  it("starts a Tabs with its catalog defaults - two tabs", () => {
    expect(newWidgetControlConfig("UTabs").props.items).toEqual([
      { label: "Tab 1", value: "tab1" },
      { label: "Tab 2", value: "tab2" },
    ]);
  });

  it("names per-item slots by the item's value, else its position", () => {
    expect(itemSlot("content", { label: "General", value: "general" }, 0)).toBe("content:general");
    expect(itemSlot("content", { label: "Otro" }, 2)).toBe("content:2");
    expect(slotBase("content:general")).toBe("content");
    expect(slotBase("footer")).toBe("footer");
  });

  it("leaves every prop at Nuxt UI's default otherwise", () => {
    expect(newWidgetControlConfig("UInput").props).toEqual({});
  });
});

describe("validateWidgetControlConfig()", () => {
  it("refuses an option field written as a formula - it names a field; the formula is a binding (T64)", () => {
    const select = (props: Record<string, unknown>, bindings: Record<string, unknown> = {}) =>
      validateWidgetControlConfig({ widget: "USelectMenu", props, bindings: { items: { kind: "variable", variable: "clientes" }, ...bindings }, emits: {} }, VARIABLES);
    expect(select({ labelKey: '{{tipo}} + " " + {{numero}}' })[0]).toMatch(/bindings: \{ "labelKey": \{ "kind": "formula"/);
    expect(select({ labelKey: "razon_social" })).toEqual([]);
    expect(select({}, { labelKey: { kind: "formula", formula: '{{tipo}} + " " + {{numero}}' } })).toEqual([]);
  });

  it("takes a form field's Pattern only when it compiles", () => {
    const field = (pattern: unknown) => ({ widget: "UFormField", props: { pattern, patternMessage: "Eleven digits." }, bindings: {}, emits: {} });
    expect(validateWidgetControlConfig(field("[0-9]{11}"))).toEqual([]);
    expect(validateWidgetControlConfig(field("[0-9"))).toEqual(["Form field's Pattern has an invalid value."]);
    expect(validateWidgetControlConfig(field(11))).toEqual(["Form field's Pattern has an invalid value."]);
  });

  it("takes a Result's waiting state, its timing as a number or a formula, and its Back to waiting event", () => {
    const result = (props: Record<string, unknown>, bindings: Record<string, unknown> = {}) =>
      validateWidgetControlConfig({ widget: "TResult", props, bindings, emits: { reset: "onIdle" } });
    expect(result({ idleTitle: "Ready", idleIcon: "i-lucide-scan-line", idleColor: "info", resetAfter: 4, variant: "soft", size: "xl", sound: false })).toEqual([]);
    expect(result({}, { resetAfter: { kind: "formula", formula: "{{vars.seconds.value}}" } })).toEqual([]);
    expect(result({ idleColor: "purple" })).toEqual(["Result's Waiting color has an invalid value."]);
    expect(result({ resetAfter: "5" })).toEqual(["Result's Reset after has an invalid value."]);
    expect(widgetState("TResult")).toEqual({});
  });

  it("takes a Table's Columns as each column's settings", () => {
    const table = (columnSettings: unknown) => validateWidgetControlConfig({ widget: "UTable", props: { columnSettings }, bindings: {}, emits: {} });
    expect(table({ precio: { label: "Precio", displayFormat: "#,##0.00", bold: true, align: "right" }, id: { hidden: true } })).toEqual([]);
    expect(table(["codigo"])).toEqual(["Table's Columns has an invalid value."]);
    expect(table({ precio: { min: 0 } })).toEqual(["Table's Columns has an invalid value."]);
    expect(table({ precio: { bold: "yes" } })).toEqual(["Table's Columns has an invalid value."]);
  });

  it("takes an option list's field as a field, or as a formula per option - never its Value field", () => {
    const radio = (bindings: Record<string, unknown>) =>
      validateWidgetControlConfig({ widget: "URadioGroup", props: { labelKey: "descripcion" }, bindings: { items: { kind: "variable", variable: "formas" }, ...bindings }, emits: {} });
    expect(radio({ colorKey: { kind: "formula", formula: '{{saldo}} < 0 ? "error" : "success"' }, disabledKey: { kind: "formula", formula: "{{id}} == 5" } })).toEqual([]);
    expect(radio({ valueKey: { kind: "formula", formula: "{{id}}" } })).toEqual(["Radio group's Value field can't be bound to a formula."]);
  });

  it("takes a Disabled and an Icon field per option on every option list - Icon not on a Checkbox group, whose icon is its check", () => {
    const list = (widget: string, bindings: Record<string, unknown>) =>
      validateWidgetControlConfig({ widget, props: {}, bindings: { items: { kind: "variable", variable: "clientes" }, ...bindings }, emits: {} });
    const perOption = { disabledKey: { kind: "formula", formula: "!{{cuenta}}" }, iconKey: { kind: "formula", formula: '{{cuenta}} ? "i-lucide-check" : ""' } };
    for (const widget of ["USelect", "USelectMenu", "UInputMenu", "UListbox"]) expect(list(widget, perOption)).toEqual([]);
    expect(list("UCheckboxGroup", { disabledKey: perOption.disabledKey })).toEqual([]);
    expect(list("UCheckboxGroup", { iconKey: perOption.iconKey })).toEqual(['Checkbox group has no prop "iconKey".']);
  });

  it("takes a formula for what may follow the page's data: a variant, a trailing icon, an embed's Read only", () => {
    const formula = (widget: string, prop: string) =>
      validateWidgetControlConfig({ widget, props: {}, bindings: { [prop]: { kind: "formula", formula: "{{vars.estado.value}}" } }, emits: {} });
    expect(formula("UBadge", "variant")).toEqual([]);
    expect(formula("UButton", "trailingIcon")).toEqual([]);
    expect(formula("TDataView", "readOnly")).toEqual([]);
    expect(formula("TDataView", "readOnly")).toEqual([]);
    expect(formula("UFormField", "patternMessage")).toEqual([]);
    expect(formula("UUser", "avatar")).toEqual([]);
  });

  it("takes a Tabs', an Accordion's or a Dropdown menu's items - only what each holds, keys never repeated", () => {
    const items = (widget: string, value: unknown) => validateWidgetControlConfig({ widget, props: { items: value }, bindings: {}, emits: {} });
    const tab = { value: "pagos", label: "Pagos", icon: "i-lucide-banknote", formulas: { label: '"Pagos (" + {{vars.pagos.count}} + ")"', disabled: "!{{vars.cliente.value}}", visible: "true" } };
    expect(items("UTabs", [tab, { value: "general", label: "General" }])).toEqual([]);
    expect(items("UTabs", [tab, tab])).toEqual(["Tabs's Tabs has an invalid value."]);
    expect(items("UTabs", [{ ...tab, onSelect: "anular" }])).toEqual(["Tabs's Tabs has an invalid value."]);
    expect(items("UAccordion", [{ value: "a", formulas: { color: "x" } }])).toEqual(["Accordion's Sections has an invalid value."]);
    expect(items("UDropdownMenu", [{ value: "anular", label: "Anular", color: "error", onSelect: "anular", formulas: { disabled: "{{vars.pagada.value}}" } }])).toEqual([]);
    expect(items("UDropdownMenu", [{ label: "Anular", color: "red" }])).toEqual(["Dropdown menu's Items has an invalid value."]);
  });

  it("binds a Tabs' open tab to a Value", () => {
    expect(validateWidgetControlConfig({ widget: "UTabs", props: {}, bindings: { modelValue: { kind: "variable", variable: "cliente" } }, emits: {} }, VARIABLES)).toEqual([]);
  });

  it("takes a Table's computed columns, its cells' color and its row color per row", () => {
    const table = (props: Record<string, unknown>, bindings: Record<string, unknown> = {}) =>
      validateWidgetControlConfig({ widget: "UTable", props, bindings: { data: { kind: "variable", variable: "items" }, ...bindings }, emits: {} });
    const total = { key: "total", label: "Total", type: "number", formula: "{{cantidad}} * {{precio}}" };
    expect(table({ computedColumns: [total], columnSettings: { total: { displayFormat: "#,##0.00", colorFormula: '{{saldo}} < 0 ? "red" : ""' } } })).toEqual([]);
    expect(table({}, { rowColorKey: { kind: "formula", formula: '{{vencida}} ? "red" : ""' } })).toEqual([]);
    expect(table({ computedColumns: [total, total] })).toEqual(["Table's Computed columns has an invalid value."]);
    expect(table({ computedColumns: [{ ...total, type: "money" }] })).toEqual(["Table's Computed columns has an invalid value."]);
    expect(table({ computedColumns: [{ ...total, key: "Total Neto" }] })).toEqual(["Table's Computed columns has an invalid value."]);
  });

  it("takes a Table's Row actions' Disabled and Visible formulas per row", () => {
    const table = (actions: unknown) => validateWidgetControlConfig({ widget: "UTable", props: { actions }, bindings: {}, emits: {} });
    expect(table([{ name: "anular", formulas: { disabled: '{{estado}} == "ANULADA"', visible: "true" } }])).toEqual([]);
    expect(table([{ name: "anular", formulas: { color: "red" } }])).toEqual(["Table's Row actions has an invalid value."]);
  });

  it("takes a formula as an input's Value - a computed input - but not as a Tabs' open tab", () => {
    const bind = (widget: string) =>
      validateWidgetControlConfig({ widget, props: {}, bindings: { modelValue: { kind: "formula", formula: "{{controls.selectCliente.item.numero_documento}}" } }, emits: {} });
    expect(bind("UInput")).toEqual([]);
    expect(bind("UInputNumber")).toEqual([]);
    expect(bind("UTabs")).toEqual(["Tabs's Open tab can't be bound to a formula."]);
  });

  it("takes a Table's Row actions only with a distinct name each", () => {
    const table = (actions: unknown) => validateWidgetControlConfig({ widget: "UTable", props: { actions }, bindings: {}, emits: { action: "onRowAction" } });
    expect(table([{ name: "agregar", icon: "i-lucide-plus", label: "Agregar" }, { name: "ver" }])).toEqual([]);
    expect(table([{ icon: "i-lucide-plus" }])).toEqual(["Table's Row actions has an invalid value."]);
    expect(table([{ name: " " }])).toEqual(["Table's Row actions has an invalid value."]);
    expect(table([{ name: "ver" }, { name: "ver" }])).toEqual(["Table's Row actions has an invalid value."]);
  });

  it("accepts a valid config", () => {
    expect(
      validateWidgetControlConfig(
        {
          widget: "USelectMenu",
          props: { labelKey: "razon_social", size: "sm", disabled: false },
          bindings: { modelValue: { kind: "variable", variable: "cliente" }, items: { kind: "variable", variable: "clientes" } },
          emits: { "update:modelValue": "onClienteChange" },
        },
        VARIABLES,
      ),
    ).toEqual([]);
  });

  it("rejects an unknown widget", () => {
    expect(validateWidgetControlConfig({ widget: "UChart", props: {}, bindings: {}, emits: {} })).toEqual(['Unknown widget "UChart".']);
  });

  it("rejects props and events the widget doesn't have", () => {
    expect(validateWidgetControlConfig({ widget: "UButton", props: { labell: "x" }, bindings: {}, emits: { pressed: "f" } })).toEqual([
      'Button has no prop "labell".',
      'Button has no event "pressed".',
    ]);
  });

  it("checks literal values against the prop's editor", () => {
    expect(
      validateWidgetControlConfig({ widget: "UButton", props: { size: "huge", color: "#f00", block: "yes" }, bindings: {}, emits: {} }),
    ).toEqual(["Button's Size has an invalid value.", "Button's Color has an invalid value.", "Button's Full width has an invalid value."]);
    // An embedded DataView is an id - PostgreSQL's foreign key checks it exists - its view a list type, its columns names.
    const embed = (props: Record<string, unknown>) => validateWidgetControlConfig({ widget: "TDataView", props: { dataview: "8981554d-a99d-4aca-a3e7-96c7543b54fa", column: "factura", ...props }, bindings: {}, emits: {} });
    expect(embed({ view: "CARDS", columns: ["fecha", "importe"], toolbarMode: "none", tools: { export: true, print: false }, allow: ["create"] })).toEqual([]);
    expect(embed({ tools: { teleport: true } })).toEqual(["DataView's Toolbar functions has an invalid value."]);
    expect(embed({ allow: ["create", "read"] })).toEqual(["DataView's Allow has an invalid value."]);
    expect(embed({ dataview: "facturas-items" })).toEqual(["DataView's DataView has an invalid value."]);
    expect(embed({ view: "FORM" })).toEqual(["DataView's View has an invalid value."]);
    expect(embed({ columns: ["fecha", "fecha"] })).toEqual(["DataView's Columns has an invalid value."]);
  });

  it("takes an image as a file's id or a URL - never a script", () => {
    const image = (src: string) => validateWidgetControlConfig({ widget: "TImage", props: { src }, bindings: {}, emits: {} });
    expect(image("8981554d-a99d-4aca-a3e7-96c7543b54fa")).toEqual([]);
    expect(image("https://example.com/dni.svg")).toEqual([]);
    expect(image("/api/totalbase/table/files/8981554d-a99d-4aca-a3e7-96c7543b54fa")).toEqual([]);
    expect(image("javascript:alert(1)")).toEqual(["Image's Image has an invalid value."]);
  });

  it("allows a formula only where the prop offers one", () => {
    expect(
      validateWidgetControlConfig({
        widget: "UButton",
        props: {},
        bindings: { label: { kind: "formula", formula: "{{vars.total.value}}" }, size: { kind: "formula", formula: "'sm'" } },
        emits: {},
      }),
    ).toEqual(["Button's Size can't be bound to a formula."]);
  });

  it("binds a data prop only to an existing variable of the right kind", () => {
    expect(
      validateWidgetControlConfig(
        {
          widget: "USelectMenu",
          props: {},
          bindings: {
            modelValue: { kind: "variable", variable: "clientes" },
            items: { kind: "variable", variable: "productos" },
            labelKey: { kind: "variable", variable: "cliente" },
          },
          emits: {},
        },
        VARIABLES,
      ),
    ).toEqual([
      "Select menu's Value needs a VALUE variable.",
      "Select menu's Options is bound to a variable that doesn't exist.",
      "Select menu's Label field can't be bound to a variable.",
    ]);
  });

  it("accepts TotalBase's common props - Read only on inputs only", () => {
    expect(
      validateWidgetControlConfig({
        widget: "UInput",
        props: { visible: false, readonly: true, cssClass: "max-w-sm", htmlAttrs: { "data-test": "total" } },
        bindings: { visible: { kind: "formula", formula: "{{vars.total.value}} > 0" } },
        emits: {},
      }),
    ).toEqual([]);
    expect(validateWidgetControlConfig({ widget: "UButton", props: { readonly: true }, bindings: {}, emits: {} })).toEqual([
      'Button has no prop "readonly".',
    ]);
    expect(validateWidgetControlConfig({ widget: "UButton", props: { htmlAttrs: { title: 3 } }, bindings: {}, emits: {} })).toEqual([
      "Button's HTML attributes has an invalid value.",
    ]);
  });

  it("rejects an event with no function", () => {
    expect(validateWidgetControlConfig({ widget: "UButton", props: {}, bindings: {}, emits: { click: "" } })).toEqual([
      "Button's \"click\" event has no function.",
    ]);
  });
});

describe("templateFormula()", () => {
  it("quotes a template's text and joins its fields with +", () => {
    expect(templateFormula("{{code}} - {{name}}")).toBe('{{code}} + " - " + {{name}}');
    expect(templateFormula("{{name}} ({{country}})")).toBe('{{name}} + " (" + {{country}} + ")"');
    expect(templateFormula('Cliente "{{ name }}"')).toBe('"Cliente \\"" + {{name}} + "\\""');
  });

  it("starts two fields side by side from text, so numbers don't add up", () => {
    expect(templateFormula("{{a}}{{b}}")).toBe('"" + {{a}} + {{b}}');
    expect(templateFormula("{{name}}")).toBe("{{name}}");
  });
});

describe("widgetState()", () => {
  it("exposes an input's value, an option list's item, a Table's row", () => {
    expect(Object.keys(widgetState("UInput"))).toEqual(["value"]);
    expect(Object.keys(widgetState("USelectMenu"))).toEqual(["value", "item"]);
    expect(Object.keys(widgetState("UCheckboxGroup"))).toEqual(["value"]);
    expect(Object.keys(widgetState("UTabs"))).toEqual(["value"]);
    expect(Object.keys(widgetState("UTable"))).toEqual(["row"]);
    expect(widgetState("UButton")).toEqual({});
  });
});
