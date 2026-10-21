/**
 * The snippet catalog (DataViews.md §11.2): small
 * wizards that ask two or three things and write plain code - nothing hidden
 * at run time. What a snippet leaves is JavaScript the author reads and
 * changes: a handler's body ("Create handler") or lines at the cursor (the
 * Code's "Insert snippet").
 *
 * Plain data, like the widget and variable catalogs: adding a snippet is
 * adding an entry. User values reach the code through `JSON.stringify`, so a
 * message or a URL never breaks it; names (a variable, a control) must be
 * identifiers - `validateSnippet()` refuses anything else before `render()`.
 */

export type SnippetGroup = "data" | "record" | "controls" | "navigation" | "feedback";

export const SNIPPET_GROUPS: readonly { key: SnippetGroup; label: string }[] = [
  { key: "data", label: "Data" },
  { key: "record", label: "Record" },
  { key: "controls", label: "Controls" },
  { key: "navigation", label: "Navigation" },
  { key: "feedback", label: "Feedback" },
];

/** A method a placed widget exposes - what a `control` param offers. */
export type SnippetControlMethod = "open" | "close" | "submit" | "clear" | "focus";

export type SnippetParam =
  | { editor: "variable"; label: string; kind: "VALUE" | "RESOURCE" | "CALL"; required?: boolean; description?: string }
  | { editor: "control"; label: string; method: SnippetControlMethod; required?: boolean; description?: string }
  | { editor: "text"; label: string; required?: boolean; description?: string }
  | { editor: "boolean"; label: string; default?: boolean; description?: string }
  | { editor: "select"; label: string; options: readonly { value: string; label: string }[]; default: string; description?: string }
  /** Another DataView, by slug. */
  | { editor: "dataview"; label: string; required?: boolean; description?: string }
  /** Another snippet and its answers: `{ snippet, params }` - what "Ask for confirmation, then…" runs. */
  | { editor: "snippet"; label: string; description?: string };

export type SnippetParams = Record<string, unknown>;

export interface SnippetDefinition {
  label: string;
  description: string;
  icon: string;
  group: SnippetGroup;
  params: Readonly<Record<string, SnippetParam>>;
  /** Only on a page with a record (DataViews.md §8.5). */
  requires?: "record";
  /** The code: statements for a handler `(dataview, event)`, one per line - may `await` and `return`. */
  render: (params: SnippetParams) => string[];
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const js = (value: unknown) => JSON.stringify(value);
const text = (params: SnippetParams, name: string) => (typeof params[name] === "string" ? (params[name] as string).trim() : "");

export const SNIPPET_CATALOG = {
  runCall: {
    label: "Run a workflow or function",
    description: "Executes a Call, then opens its file or tells the viewer; a failure shows its message.",
    icon: "i-lucide-play",
    group: "data",
    params: {
      call: { editor: "variable", label: "Call", kind: "CALL", required: true },
      input: {
        editor: "select",
        label: "Input",
        options: [
          { value: "designed", label: "Its designed input" },
          { value: "event", label: "The event - a form's submit, { data }" },
          { value: "record", label: "The page's record - { data: record.data }" },
        ],
        default: "designed",
      },
      openFile: { editor: "boolean", label: "Open the result as a file", description: "A print or a PDF: { asset } or { mimeType, content }." },
      success: { editor: "text", label: "Message when it succeeds", description: "Optional." },
    },
    render: (params) => [
      "try {",
      `  const result = await dataview.vars.${params.call as string}.execute(${params.input === "event" ? "event" : params.input === "record" ? "{ data: { ...dataview.vars.record.data } }" : ""})`,
      ...(params.openFile === true ? ["  dataview.openFile(result)"] : ["  // result is what it returned"]),
      ...(text(params, "success") ? [`  dataview.notify(${js(text(params, "success"))}, "success")`] : []),
      "} catch (error) {",
      '  dataview.notify(error.message, "error")',
      "}",
    ],
  },
  saveRecord: {
    label: "Save the record",
    description: "Saves it; if PostgreSQL says no, the viewer sees why and the record stays as it was.",
    icon: "i-lucide-save",
    group: "record",
    requires: "record",
    params: {
      then: {
        editor: "select",
        label: "Then",
        options: [
          { value: "stay", label: "Stay on it" },
          { value: "new", label: "Start a new one" },
          { value: "close", label: "Close it" },
        ],
        default: "stay",
      },
      success: { editor: "text", label: "Message when it saves", description: "Optional." },
    },
    render: (params) => [
      "if (!await dataview.vars.record.save()) return",
      ...(text(params, "success") ? [`dataview.notify(${js(text(params, "success"))}, "success")`] : []),
      ...(params.then === "new" ? ["dataview.vars.record.new()"] : params.then === "close" ? ["dataview.vars.record.close()"] : []),
    ],
  },
  recordAction: {
    label: "A record action",
    description: "New, undo the changes, delete (asks first), clone or reread the record.",
    icon: "i-lucide-file-pen-line",
    group: "record",
    requires: "record",
    params: {
      action: {
        editor: "select",
        label: "Action",
        options: [
          { value: "new", label: "Start a new one" },
          { value: "cancel", label: "Undo the changes" },
          { value: "delete", label: "Delete it" },
          { value: "clone", label: "Copy it into a new one" },
          { value: "refresh", label: "Reread it, keeping the changes" },
          { value: "reload", label: "Reread it, dropping the changes" },
        ],
        default: "new",
      },
    },
    render: (params) => {
      const action = typeof params.action === "string" && /^(new|cancel|delete|clone|refresh|reload)$/.test(params.action) ? params.action : "new";
      return [`${action === "delete" || action === "refresh" || action === "reload" ? "await " : ""}dataview.vars.record.${action}()`];
    },
  },
  setRecordColumn: {
    label: "Set a column of the record",
    description: "Puts a value in one of the record's columns - the event's, or a fixed one. Saved with the record.",
    icon: "i-lucide-pencil-line",
    group: "record",
    requires: "record",
    params: {
      column: { editor: "text", label: "Column", required: true },
      from: {
        editor: "select",
        label: "To",
        options: [
          { value: "event", label: "The event's value" },
          { value: "text", label: "A fixed value" },
        ],
        default: "event",
      },
      value: { editor: "text", label: "Fixed value", description: "When To is a fixed value." },
    },
    render: (params) => [`dataview.vars.record.set(${js(text(params, "column"))}, ${params.from === "text" ? js(text(params, "value")) : "event.value"})`],
  },
  refreshData: {
    label: "Refresh data",
    description: "Reads a Resource again - every widget bound to it updates.",
    icon: "i-lucide-refresh-cw",
    group: "data",
    params: { resource: { editor: "variable", label: "Resource", kind: "RESOURCE", required: true } },
    render: (params) => [`await dataview.vars.${params.resource as string}.refresh()`],
  },
  filterResource: {
    label: "Filter a Resource by a value",
    description: "A runtime filter on one column, AND-ed with its designed where - an empty value clears it.",
    icon: "i-lucide-filter",
    group: "data",
    params: {
      resource: { editor: "variable", label: "Resource", kind: "RESOURCE", required: true },
      column: { editor: "text", label: "Column", required: true },
      operator: {
        editor: "select",
        label: "Match",
        options: [
          { value: "_eq", label: "Equal" },
          { value: "_ilike", label: "Contains (any case)" },
          { value: "_gte", label: "From (greater or equal)" },
          { value: "_lte", label: "Up to (less or equal)" },
        ],
        default: "_eq",
      },
      from: {
        editor: "select",
        label: "Value",
        options: [
          { value: "event", label: "The event's value" },
          { value: "variable", label: "A Value variable" },
        ],
        default: "event",
      },
      variable: { editor: "variable", label: "Value variable", kind: "VALUE", description: "When Value is a Value variable." },
    },
    render: (params) => {
      const source = params.from === "variable" && typeof params.variable === "string" ? `dataview.vars.${params.variable}.value` : "event.value";
      const operator = typeof params.operator === "string" && /^_(eq|ilike|gte|lte)$/.test(params.operator) ? params.operator : "_eq";
      const resource = `dataview.vars.${params.resource as string}`;
      return [
        `const value = ${source}`,
        "if (value === null || value === undefined || value === \"\") {",
        `  await ${resource}.clearFilter()`,
        "} else {",
        `  await ${resource}.setFilter({ ${js(text(params, "column"))}: { ${operator}: ${operator === "_ilike" ? "`%${value}%`" : "value"} } })`,
        "}",
      ];
    },
  },
  searchResource: {
    label: "Search a Resource",
    description: "The event's value (what was typed) as the Resource's search.",
    icon: "i-lucide-search",
    group: "data",
    params: { resource: { editor: "variable", label: "Resource", kind: "RESOURCE", required: true } },
    render: (params) => [`await dataview.vars.${params.resource as string}.setSearch(event.value ?? "")`],
  },
  useSelectedRow: {
    label: "Use the selected row",
    description: "On a Table's select: puts one of the row's fields in a Value.",
    icon: "i-lucide-mouse-pointer-click",
    group: "data",
    params: {
      variable: { editor: "variable", label: "Value", kind: "VALUE", required: true },
      field: { editor: "text", label: "Field of the row", required: true, description: "A field the Table's Resource reads - id, nombre…" },
    },
    render: (params) => [`dataview.vars.${params.variable as string}.set(event.row?.[${js(text(params, "field"))}] ?? null)`],
  },
  setVariable: {
    label: "Set a variable",
    description: "Puts a value in a Value - the event's, or a fixed one.",
    icon: "i-lucide-variable",
    group: "data",
    params: {
      variable: { editor: "variable", label: "Value", kind: "VALUE", required: true },
      from: {
        editor: "select",
        label: "To",
        options: [
          { value: "event", label: "The event's value" },
          { value: "text", label: "A fixed value" },
        ],
        default: "event",
      },
      value: { editor: "text", label: "Fixed value", description: "When To is a fixed value." },
    },
    render: (params) => [`dataview.vars.${params.variable as string}.set(${params.from === "text" ? js(text(params, "value")) : "event.value"})`],
  },
  submitForm: {
    label: "Submit a form",
    description: "Validates it and emits its submit - as its submit button would.",
    icon: "i-lucide-send",
    group: "controls",
    params: { form: { editor: "control", label: "Form", method: "submit", required: true } },
    render: (params) => [`await dataview.controls.${params.form as string}.submit()`],
  },
  toggleOverlay: {
    label: "Open or close a modal or slideover",
    description: "By the name it has in the Design form.",
    icon: "i-lucide-app-window",
    group: "controls",
    params: {
      overlay: { editor: "control", label: "Modal or slideover", method: "open", required: true },
      action: {
        editor: "select",
        label: "Action",
        options: [
          { value: "open", label: "Open it" },
          { value: "close", label: "Close it" },
        ],
        default: "open",
      },
    },
    render: (params) => [`dataview.controls.${params.overlay as string}.${params.action === "close" ? "close" : "open"}()`],
  },
  clearForm: {
    label: "Clear a form's errors",
    description: "Removes the messages its validation left.",
    icon: "i-lucide-eraser",
    group: "controls",
    params: { form: { editor: "control", label: "Form", method: "clear", required: true } },
    render: (params) => [`dataview.controls.${params.form as string}.clear()`],
  },
  focusInput: {
    label: "Focus an input",
    description: "Puts the cursor in it - after opening a modal, or when a check fails.",
    icon: "i-lucide-text-cursor-input",
    group: "controls",
    params: { input: { editor: "control", label: "Input", method: "focus", required: true } },
    render: (params) => [`dataview.controls.${params.input as string}.focus()`],
  },
  openLink: {
    label: "Open a link",
    description: "A URL, here or in a new tab.",
    icon: "i-lucide-external-link",
    group: "navigation",
    params: {
      url: { editor: "text", label: "URL", required: true },
      newTab: { editor: "boolean", label: "In a new tab", default: true },
    },
    render: (params) => [params.newTab === false ? `window.location.assign(${js(text(params, "url"))})` : `window.open(${js(text(params, "url"))}, "_blank")`],
  },
  openDataView: {
    label: "Open another DataView",
    description: "Goes to it - with this record's key as its ?pk=, which opens that record there.",
    icon: "i-lucide-panels-top-left",
    group: "navigation",
    params: {
      dataview: { editor: "dataview", label: "DataView", required: true },
      withRecord: { editor: "boolean", label: "Pass this record's key (pk)", description: "Only on a page with a record." },
      newTab: { editor: "boolean", label: "In a new tab" },
    },
    render: (params) => [
      `dataview.openDataView(${js(text(params, "dataview"))}${params.withRecord === true ? ", { pk: dataview.vars.record.pk }" : ", {}"}${params.newTab === true ? ", { newTab: true }" : ""})`,
    ],
  },
  confirmThen: {
    label: "Ask for confirmation, then…",
    description: "Stops unless the viewer confirms - then runs another snippet.",
    icon: "i-lucide-circle-help",
    group: "feedback",
    params: {
      message: { editor: "text", label: "Question", required: true },
      title: { editor: "text", label: "Title", description: "Optional - the dialog's heading." },
      button: { editor: "text", label: "Confirm button", description: "Optional - \"OK\" otherwise." },
      then: { editor: "snippet", label: "Then" },
    },
    render: (params) => {
      const next = params.then as { snippet?: string; params?: SnippetParams } | undefined;
      const titled = text(params, "title") || text(params, "button");
      const question = titled
        ? `{ title: ${js(text(params, "title") || "Confirm")}, lines: [${js(text(params, "message"))}], confirm: ${js(text(params, "button") || "OK")} }`
        : js(text(params, "message"));
      return [`if (!await dataview.confirm(${question})) return`, ...(next?.snippet ? renderSnippet(next.snippet, next.params ?? {}) : [])];
    },
  },
  copyToClipboard: {
    label: "Copy to the clipboard",
    description: "The event's value or a fixed text, with a notification.",
    icon: "i-lucide-clipboard-copy",
    group: "feedback",
    params: {
      from: {
        editor: "select",
        label: "What",
        options: [
          { value: "event", label: "The event's value" },
          { value: "text", label: "A fixed text" },
        ],
        default: "event",
      },
      value: { editor: "text", label: "Fixed text", description: "When What is a fixed text." },
    },
    render: (params) => [
      `await navigator.clipboard.writeText(String(${params.from === "text" ? js(text(params, "value")) : "event.value ?? \"\""}))`,
      'dataview.notify("Copied", "success")',
    ],
  },
  notify: {
    label: "Show a notification",
    description: "A message in the corner.",
    icon: "i-lucide-bell",
    group: "feedback",
    params: {
      message: { editor: "text", label: "Message", required: true },
      color: {
        editor: "select",
        label: "Color",
        options: ["info", "success", "warning", "error"].map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) })),
        default: "info",
      },
    },
    render: (params) => [`dataview.notify(${js(text(params, "message"))}, ${js(typeof params.color === "string" ? params.color : "info")})`],
  },
} as const satisfies Record<string, SnippetDefinition>;

export type SnippetName = keyof typeof SNIPPET_CATALOG;
export const SNIPPET_NAMES = Object.keys(SNIPPET_CATALOG) as SnippetName[];

export function isSnippetName(value: string): value is SnippetName {
  return Object.prototype.hasOwnProperty.call(SNIPPET_CATALOG, value);
}

export function snippetDefinition(name: SnippetName): SnippetDefinition {
  return SNIPPET_CATALOG[name];
}

/** A param's value when the author left it unanswered. */
export function snippetDefaults(name: SnippetName): SnippetParams {
  const out: SnippetParams = {};
  for (const [key, param] of Object.entries(snippetDefinition(name).params)) {
    if (param.editor === "select") out[key] = param.default;
    else if (param.editor === "boolean") out[key] = param.default ?? false;
  }
  return out;
}

/** What's missing or not a name - nothing is rendered until this is empty. */
export function validateSnippet(name: string, params: SnippetParams): string[] {
  if (!isSnippetName(name)) return [`Unknown snippet "${name}".`];
  const errors: string[] = [];
  for (const [key, param] of Object.entries(snippetDefinition(name).params)) {
    const value = params[key];
    const empty = value === undefined || value === null || (typeof value === "string" && value.trim() === "");
    if ("required" in param && param.required && empty) {
      errors.push(`${param.label} is required.`);
      continue;
    }
    if (empty) continue;
    if ((param.editor === "variable" || param.editor === "control") && (typeof value !== "string" || !IDENTIFIER.test(value))) {
      errors.push(`${param.label} must be a name.`);
    }
    if (param.editor === "dataview" && (typeof value !== "string" || !SLUG.test(value))) errors.push(`${param.label} must be a DataView's slug.`);
    if (param.editor === "snippet") {
      const next = value as { snippet?: unknown; params?: unknown };
      if (typeof next.snippet !== "string") errors.push(`${param.label}: pick a snippet.`);
      else errors.push(...validateSnippet(next.snippet, (next.params ?? {}) as SnippetParams).map((e) => `${param.label}: ${e}`));
    }
  }
  return errors;
}

/** The snippet's lines - valid params assumed (`validateSnippet`). */
export function renderSnippet(name: string, params: SnippetParams): string[] {
  if (!isSnippetName(name)) return [];
  return snippetDefinition(name).render({ ...snippetDefaults(name), ...params });
}
