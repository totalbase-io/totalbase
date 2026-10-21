import {
  renderSnippet,
  RESERVED_VARIABLE_NAMES,
  templateColumns,
  templateFormula,
  widgetDefinition,
  type ResourceVariableDefinition,
  type WidgetName,
} from "@totalbase/tb-catalog";

/**
 * The page a FORM or MASTER_DETAIL wizard generates for its record form
 * (DataViews.md §6.1): content, the author's
 * from then on - a `UForm` with a `UFormField` per column bound to the
 * record, a Detail for a Master-detail, the buttons, and their Code written
 * with the snippet catalog. What depends on the database stays live: the
 * record's columns, required, a foreign key's options (a Resource of its
 * target table). Pure: the service reads the catalog and writes the result.
 */

/** A column the form edits, as the wizard chose it. */
export interface RecordPageColumn {
  /** PostgreSQL fills it (a key's DEFAULT, a creation stamp, identity, generated): shown once the record exists, not on a new one. */
  filledByPostgres?: boolean;
  name: string;
  label: string;
  /** The wizard's help text - the form field's `help`, under its input. */
  help?: string;
  /** Its input - a form-field widget. */
  widget: WidgetName;
  /** The input is its column's - the field follows it while it has none of its own (§15.2). */
  fromColumn?: boolean;
  /** A foreign key's options: a Resource of its target table, the input bound to it. */
  options?: { resource: string; valueKey: string; labelKey: string; variable: string; template?: string };
  /** A text column whose CHECK is a list (`IN (...)`): its values, the select's fixed options. */
  values?: string[];
}

export interface RecordPageInput {
  /**
   * Which page: a FORM's, a MASTER_DETAIL's (with its Detail) or a GRID's
   * record form. None carries a Save: every record page's frame has Cancel
   * and Save in its footer (AGENTS.md section 25) - the page holds only its
   * fields, and what its author adds.
   */
  type: "FORM" | "MASTER_DETAIL" | "GRID";
  columns: readonly RecordPageColumn[];
  /** MASTER_DETAIL: the detail DataView and its column pointing at the record. */
  detail?: { dataview: string; column: string };
}

/** A widget to place, with what its slots hold. */
export interface GeneratedWidget {
  widget: WidgetName;
  /** Its name in code - `dataview.controls.<name>`. */
  name?: string;
  props: Record<string, unknown>;
  bindings?: Record<string, unknown>;
  emits?: Record<string, string>;
  /** Columns of 12. */
  width: number;
  /** Rows of 40px - a sizable widget's height. */
  height?: number;
  slots?: Record<string, GeneratedWidget[]>;
  /** A form field's input that follows its column's (`WidgetFieldConfig.fromColumn`). */
  fromColumn?: boolean;
}

export interface GeneratedPage {
  variables: ResourceVariableDefinition[];
  widgets: GeneratedWidget[];
  code: string;
}

/** A form with more fields than this lays them out two to a row. */
const TWO_UP_AFTER = 6;
/** What a foreign key's select is given its options by. */
const OPTION_INPUTS: readonly WidgetName[] = ["USelectMenu", "USelect", "UInputMenu", "URadioGroup"];

/** A foreign key column's input can take its options from a Resource. */
export function takesOptions(widget: WidgetName): boolean {
  return OPTION_INPUTS.includes(widget);
}

function handler(name: string, what: string, body: readonly string[]): string {
  return `// ${what}.\nasync function ${name}(dataview, event) {\n${body.map((line) => `  ${line}`).join("\n")}\n}\n`;
}

/** A form field's props: its column and - when the wizard gave one of its own - label and help. */
/** A field PostgreSQL fills: nothing to type on a new record - it shows once there is one. */
const NOT_ON_CREATE = { visible: { kind: "formula", formula: '{{vars.record.mode}} != "create"' } };

function fieldProps(column: RecordPageColumn): Record<string, unknown> {
  // No label: the form field shows its column's, inherited live (DataViews.md §15).
  return { column: column.name, ...(column.label ? { label: column.label } : {}), ...(column.help?.trim() ? { help: column.help.trim() } : {}) };
}

export function generateRecordPage(input: RecordPageInput): GeneratedPage {
  const isMasterDetail = input.type === "MASTER_DETAIL";
  const width = isMasterDetail ? 3 : input.columns.length > TWO_UP_AFTER ? 6 : 12;

  const fields: GeneratedWidget[] = input.columns.map((column) => {
    const widget = widgetDefinition(column.widget).formField ? column.widget : "UInput";
    if (column.values && takesOptions(widget)) {
      return { widget: "UFormField", props: fieldProps(column), ...(column.filledByPostgres && { bindings: NOT_ON_CREATE }), width, slots: { default: [{ widget, props: { items: column.values }, width: 12, ...(column.fromColumn && { fromColumn: true }) }] } };
    }
    return {
      widget: "UFormField",
      props: fieldProps(column),
      ...(column.filledByPostgres && { bindings: NOT_ON_CREATE }),
      width,
      slots: {
        default: [
          {
            widget,
            props: column.options && takesOptions(widget) ? { valueKey: column.options.valueKey, labelKey: column.options.labelKey } : {},
            // A row template (`{{codigo}} · {{nombre}}`): each option shows all of it, its Label field the first column.
            bindings: column.options && takesOptions(widget)
              ? { items: { kind: "variable", variable: column.options.variable }, ...(column.options.template && { labelKey: { kind: "formula", formula: templateFormula(column.options.template) } }) }
              : {},
            width: 12,
            ...(column.fromColumn && { fromColumn: true }),
          },
        ],
      },
    };
  });

  const code: string[] = [];
  const children: GeneratedWidget[] = [...fields];
  if (isMasterDetail && input.detail) {
    children.push({
      widget: "TDataView",
      name: "detail",
      // "Add item" is the generated Detail's - the grid shows it in the viewer's language (WidgetDataView.vue).
      // Its lines edited in the grid, saved with the record in one transaction (DataViews.md §6.6).
      props: { dataview: input.detail.dataview, column: input.detail.column, newLabel: "Add item", toolbarMode: "none", paging: false, editInline: true },
      emits: { rowsChanged: "onDetailRowsChanged" },
      width: 12,
      height: 8,
    });
    code.push(
      handler("onDetailRowsChanged", 'Runs on "Rows changed" of the items: reread the record - what a trigger recomputed shows up, edits in progress stay', renderSnippet("recordAction", { action: "refresh" })),
    );
  }
  return {
    variables: optionVariables(input.columns),
    widgets: [{ widget: "UForm", name: "form", props: {}, width: 12, slots: { default: children } }],
    code: code.join("\n"),
  };
}

/** The Resources feeding the foreign keys' selects - one per variable. */
function optionVariables(columns: readonly RecordPageColumn[]): ResourceVariableDefinition[] {
  const variables: ResourceVariableDefinition[] = [];
  for (const column of columns) {
    const options = column.options;
    if (!options || !takesOptions(column.widget) || variables.some((v) => v.name === options.variable)) continue;
    // Its key and every column shown - a search matches any of them (B46), ordered by the first.
    const shown = options.template ? templateColumns(options.template) : [options.labelKey];
    const fields = [...new Set([options.valueKey, ...shown])].join(",");
    variables.push({
      name: options.variable,
      kind: "RESOURCE",
      resource: options.resource,
      query: { fields, order_by: options.labelKey, limit: 100 },
      mode: "list",
      immediate: true,
      watch: false,
      count: false,
    });
  }
  return variables;
}

/** `tipos_comprobante` → `tiposComprobante`: a variable name for a table, not one of `taken`. */
export function variableNameFor(table: string, taken: readonly string[]): string {
  const words = table.split(/[^A-Za-z0-9]+/).filter(Boolean);
  let base = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase())).join("") || "rows";
  if (!/^[a-z]/.test(base)) base = `rows${base}`;
  // `record`, `vars`… are reserved.
  if (RESERVED_VARIABLE_NAMES.includes(base)) base = `${base}Rows`;
  let name = base;
  for (let i = 2; taken.includes(name); i++) name = `${base}${i}`;
  return name;
}
