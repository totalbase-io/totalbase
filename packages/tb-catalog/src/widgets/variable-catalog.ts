import { isPeriod, isRecord, type Period } from "@totalbase/shared";
import { WIDGET_NAMES, widgetDefinition, type ValueKind, type WidgetName } from "./widget-catalog.js";

/**
 * The variable catalog (DataViews.md §8): every
 * kind of variable a designed screen can hold - its data and its state - in
 * the same shape as a widget: Props (the definition, edited in the
 * Variables tab), State (read by bindings and code), Expose (methods for
 * code) and Emits (events, each bound to a Code function). The Variables
 * tab, the Preview's Variables panel, the Code's autocompletion and the
 * server's validation all read it.
 *
 * Two levels: the variable kinds (`VARIABLE_CATALOG`) and, for a Value, the
 * type of value it holds (`VALUE_TYPES`) - the same vocabulary a widget's
 * `accepts` uses, so which widgets a Value can bind to comes from there.
 *
 * Plain data, no Vue: the admin, the server and the runtime all read it.
 */

// --- Value types ---------------------------------------------------------------

/** The types a Value holds - the widget vocabulary (`ValueKind`) minus the column-only `relation` and `file`. */
export const VALUE_TYPES = [
  "text",
  "number",
  "boolean",
  "date",
  "time",
  "timestamp",
  "date_range",
  "time_range",
  "array",
  "json",
  "point",
] as const satisfies readonly ValueKind[];
export type ValueType = (typeof VALUE_TYPES)[number];

export function isValueType(value: string): value is ValueType {
  return (VALUE_TYPES as readonly string[]).includes(value);
}

export const VALUE_TYPE_META: Record<ValueType, { label: string; description: string }> = {
  text: { label: "Text", description: "A string." },
  number: { label: "Number", description: "A finite number." },
  boolean: { label: "Boolean", description: "true or false." },
  date: { label: "Date", description: "A calendar day, YYYY-MM-DD." },
  time: { label: "Time", description: "A time of day, HH:MM or HH:MM:SS." },
  timestamp: { label: "Date and time", description: "An instant, ISO 8601." },
  date_range: { label: "Date range", description: "A calendar period (this month, last year…) or two dates." },
  time_range: { label: "Time range", description: "Two times of day." },
  array: { label: "List", description: "A list of values." },
  json: { label: "JSON", description: "Any JSON value." },
  point: { label: "Point", description: "A map point, { lng, lat }." },
};

/**
 * A date range holds a calendar period, resolved by PostgreSQL when a
 * Resource's query uses it (`$PERIOD.<period>.from/.to`), or two fixed dates
 * (`to` inclusive - the last day counts; it becomes the next day, exclusive,
 * in a query).
 */
export type DateRangeValue = { period: Period } | { from: string; to: string };
export interface TimeRangeValue {
  from: string;
  to: string;
}

/**
 * The widgets a Value of `type` can bind to (their `modelValue`): those that
 * accept the type itself and, for a key a picker chooses (text or number),
 * those that pick a relation's row.
 */
export function widgetsForValueType(type: ValueType): WidgetName[] {
  const kinds: ValueKind[] = type === "text" || type === "number" ? [type, "relation"] : [type];
  return WIDGET_NAMES.filter((name) => kinds.some((kind) => widgetDefinition(name).accepts?.includes(kind)));
}

// --- Variable kinds -------------------------------------------------------------

/**
 * `VALUE` - page state; `RESOURCE` - read-only data from the Data API;
 * `CALL` - a function, a workflow or a table write run on demand; `RECORD` - the page's
 * record, a row of its DataView's source table (DataViews.md §8.5): there when the
 * DataView has one, never created by the author.
 */
export type VariableKind = "VALUE" | "RESOURCE" | "CALL" | "RECORD";

/** How the Variables tab edits a variable prop. */
export type VariablePropEditor =
  | "text"
  | "boolean"
  | "select"
  | "valueType"
  | "default"
  | "resource"
  | "query"
  | "callTarget"
  | "callInput";

export interface VariableProp {
  label: string;
  editor: VariablePropEditor;
  /** `select` editor only. */
  options?: readonly string[];
  required?: boolean;
  description?: string;
}

export interface VariableState {
  label: string;
  description: string;
}

export interface VariableMethod {
  /** How it's called, for the Code's autocompletion. */
  signature: string;
  description: string;
}

export interface VariableEmit {
  label: string;
  /** What the handler receives, for its scaffold comment. */
  payload?: string;
}

export interface VariableKindDefinition {
  label: string;
  icon: string;
  description: string;
  /** False for kinds a DataView type generates (RECORD) - never offered by "New variable". */
  creatable: boolean;
  props: Readonly<Record<string, VariableProp>>;
  state: Readonly<Record<string, VariableState>>;
  expose: Readonly<Record<string, VariableMethod>>;
  emits: Readonly<Record<string, VariableEmit>>;
}

const status = {
  label: "Status",
  description: "idle · pending · success · error",
} as const;

export const VARIABLE_CATALOG = {
  VALUE: {
    label: "Value",
    icon: "i-lucide-variable",
    description: "Page state - what the viewer picked or typed, or what code set.",
    creatable: true,
    props: {
      type: { label: "Type", editor: "valueType", required: true },
      default: {
        label: "Default",
        editor: "default",
        description: "A constant, a formula, a URL parameter or a field of the viewer ($USER).",
      },
    },
    state: { value: { label: "Value", description: "The current value, of the variable's type." } },
    expose: {
      set: { signature: "set(value)", description: "Sets the value, coerced to the variable's type." },
      reset: { signature: "reset()", description: "Back to the default." },
    },
    emits: { "update:value": { label: "Value changed", payload: "{ value, previous }" } },
  },
  RESOURCE: {
    label: "Resource",
    icon: "i-lucide-database",
    description: "Read-only data from a table or view, through the Data API and the viewer's permissions.",
    creatable: true,
    props: {
      resource: { label: "Resource", editor: "resource", required: true, description: "A table or view exposed for GET." },
      query: {
        label: "Query",
        editor: "query",
        required: true,
        description: "Fields (required), where, search, group by, aggregates, order and limit.",
      },
      mode: { label: "Mode", editor: "select", options: ["list", "record"], description: "Rows, or one row (or null)." },
      immediate: { label: "Load on open", editor: "boolean" },
      watch: { label: "Reload when its variables change", editor: "boolean" },
      count: { label: "Count the total", editor: "boolean" },
    },
    state: {
      data: { label: "Data", description: "The rows (list) or the row (record)." },
      status,
      error: { label: "Error", description: "The last error, or null." },
      count: { label: "Count", description: "The total, when Count is on." },
      page: { label: "Page", description: "The page it read, from 1 - setPage() moves it, a new search or filter goes back to 1." },
      limit: { label: "Page size", description: "Its query's limit - null when it has none." },
      search: { label: "Search", description: "What setSearch() set (a Table's search box) - null without one, the query's own search then." },
    },
    expose: {
      refresh: { signature: "refresh()", description: "Runs the query again; resolves to data." },
      execute: { signature: "execute()", description: "Same as refresh()." },
      clear: { signature: "clear()", description: "Empties data." },
      setFilter: { signature: "setFilter(filter)", description: "A runtime filter, AND-ed with the designed where." },
      clearFilter: { signature: "clearFilter()", description: "Removes the runtime filter." },
      setSearch: { signature: "setSearch(text)", description: "The query's search." },
      setOrder: { signature: "setOrder(orderBy)", description: "The query's order." },
      setPage: { signature: "setPage(n)", description: "The page, from 1." },
      find: { signature: "find(column, value)", description: "The row whose column equals value, read apart - data stays as it is; null if none." },
    },
    emits: {
      "before:load": { label: "Before load", payload: "{ query } - return false to cancel" },
      load: { label: "Loaded", payload: "{ data, meta }" },
      error: { label: "Error", payload: "{ error }" },
      "update:data": { label: "Data changed", payload: "{ data }" },
    },
  },
  CALL: {
    label: "Call",
    icon: "i-lucide-square-function",
    description: "A function, a MANUAL workflow or a table write, run on demand as the viewer.",
    creatable: true,
    props: {
      target: { label: "Target", editor: "callTarget", required: true, description: "A function, a MANUAL workflow, or a table to create, update or delete rows in." },
      input: {
        label: "Input",
        editor: "callInput",
        description: 'The request body: { "data": {...} }; a table update or delete also names its row - "pk" or "where". Values may use {{vars.*}}.',
      },
    },
    state: {
      data: { label: "Result", description: "The last result." },
      status,
      error: { label: "Error", description: "The last failure, as the API's { errors: [{ code, message }] }, or null." },
    },
    expose: {
      execute: {
        signature: "execute(input?)",
        description: "Runs it - with input, instead of the designed one; resolves to the result, rejects on failure.",
      },
      setInput: { signature: "setInput(input)", description: "Replaces the designed input." },
      clear: { signature: "clear()", description: "Empties data and error." },
    },
    emits: {
      "before:execute": { label: "Before run", payload: "{ input } - return false to cancel, an object to replace the input" },
      success: { label: "Succeeded", payload: "{ result }" },
      error: { label: "Failed", payload: "{ error }" },
      complete: { label: "Finished", payload: "- always, last" },
    },
  },
  RECORD: {
    label: "Record",
    icon: "i-lucide-file-pen-line",
    description: "A row of the DataView's source table - loaded, edited and saved through the Data API as the viewer.",
    creatable: false,
    props: {},
    state: {
      data: { label: "Data", description: "The row's values, edits included - data.<column>." },
      mode: { label: "Mode", description: "create · edit · view" },
      dirty: { label: "Unsaved changes", description: "true while it has unsaved changes." },
      status,
      error: { label: "Error", description: "The last failure, as the API's { errors: [{ code, message }] }, or null." },
      pk: { label: "Key", description: "The primary key's value - null for a new record." },
    },
    expose: {
      save: {
        signature: "save(values?)",
        description: "Saves it, with values set first; resolves to false when it didn't - the record is then left as it was.",
      },
      cancel: { signature: "cancel()", description: "Discards the changes." },
      new: { signature: "new(values?)", description: "Starts a new record, with values." },
      open: { signature: "open(pk, view?)", description: "Opens another row by its key - read-only with view, until edit()." },
      reload: { signature: "reload()", description: "Reads it again, dropping the edits." },
      refresh: {
        signature: "refresh()",
        description: "Reads it again, keeping the edits - what a trigger recomputed shows up (an embedded DataView's rowsChanged).",
      },
      delete: { signature: "delete()", description: "Deletes it, after a confirmation; resolves to whether it did." },
      edit: { signature: "edit()", description: "Leaves view mode." },
      clone: { signature: "clone()", description: "A new record with its values - not its key or generated columns." },
      close: { signature: "close()", description: "Closes the page or panel it's open in." },
      set: { signature: "set(column, value)", description: "Sets a column's value." },
    },
    emits: {
      load: { label: "Loaded", payload: "{ data }" },
      "before:save": { label: "Before save", payload: "{ data } - return false to cancel" },
      save: { label: "Saved", payload: "{ data }" },
    },
  },
} as const satisfies Record<VariableKind, VariableKindDefinition>;

export function variableKindDefinition(kind: VariableKind): VariableKindDefinition {
  return VARIABLE_CATALOG[kind];
}

/** The kinds "New variable" offers. */
export const CREATABLE_VARIABLE_KINDS = (Object.keys(VARIABLE_CATALOG) as VariableKind[]).filter(
  (kind) => VARIABLE_CATALOG[kind].creatable,
);

// --- Stored definitions ------------------------------------------------------------

/** Where a Value's default comes from. */
export type ValueDefault =
  | { source: "constant"; value: unknown }
  | { source: "formula"; formula: string }
  | { source: "param"; name: string }
  | { source: "user"; field: string };

/** Emit name → the Code function it calls - every kind's emits (`VARIABLE_CATALOG`). */
export type VariableEmits = Record<string, string>;

export interface ValueVariableDefinition {
  name: string;
  kind: "VALUE";
  type: ValueType;
  default?: ValueDefault;
  emits?: VariableEmits;
}

export interface ResourceVariableDefinition {
  name: string;
  kind: "RESOURCE";
  /** The TotalBase resource id - a rename keeps it (AGENTS.md section 9). */
  resource: string;
  /** The Data API query object; `fields` is required. `{{vars.*}}` in `where` is bound as a value, never interpolated. */
  query: { fields: string } & Record<string, unknown>;
  mode: "list" | "record";
  immediate: boolean;
  watch: boolean;
  count: boolean;
  emits?: VariableEmits;
}

/** What a table Call does - the Data API's write methods. */
export const TABLE_CALL_ACTIONS = ["CREATE", "UPDATE", "DELETE"] as const;
export type TableCallAction = (typeof TABLE_CALL_ACTIONS)[number];

export type CallTarget =
  | { type: "FUNCTION"; resource: string }
  /** A MANUAL workflow by id - a rename of its slug keeps it (the App runs it by the slug the server resolves, `variableWorkflows`). */
  | { type: "WORKFLOW"; workflow: string }
  | { type: "TABLE"; resource: string; action: TableCallAction };

export interface CallVariableDefinition {
  name: string;
  kind: "CALL";
  target: CallTarget;
  input?: Record<string, unknown>;
  emits?: VariableEmits;
}

/** What `view_config.variables` stores - RECORD is generated, never stored. */
export type VariableDefinition = ValueVariableDefinition | ResourceVariableDefinition | CallVariableDefinition;

/** Words a variable can't be named - they are identifiers in code and formulas. */
export const RESERVED_VARIABLE_NAMES: readonly string[] = [
  "vars",
  "controls",
  "slot",
  "record",
  "dataview",
  "dashboard",
  "event",
  "params",
  "api",
  "user",
  "true",
  "false",
  "null",
  "undefined",
];

const NAME = /^[a-z][a-zA-Z0-9_]*$/;
const MAX_NAME_LENGTH = 32;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
/** `{{vars.<name>` - a reference to another variable, in a formula, a where or an input. */
const VAR_REFERENCE = /\{\{\s*vars\.([a-zA-Z_][a-zA-Z0-9_]*)/g;

/**
 * Variables no author defines: `record`, the page's record, present when
 * its DataView has a source table (DataViews.md §8.5). Its name is reserved, so
 * no variable takes it; a reference to it is never "doesn't exist".
 */
export const IMPLICIT_VARIABLE_NAMES: readonly string[] = ["record"];

/**
 * Whether `value` is a valid value of `type` - what `set()` and a constant
 * default must hold. `null` is always valid (no value yet).
 */
export function isValidValue(type: ValueType, value: unknown): boolean {
  if (value === null) return true;
  switch (type) {
    case "text":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "date":
      return typeof value === "string" && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value));
    case "time":
      return typeof value === "string" && TIME.test(value);
    case "timestamp":
      return typeof value === "string" && !Number.isNaN(Date.parse(value));
    case "date_range":
      if (!isRecord(value)) return false;
      if ("period" in value) return typeof value.period === "string" && isPeriod(value.period) && Object.keys(value).length === 1;
      return isValidValue("date", value.from ?? null) && isValidValue("date", value.to ?? null) && value.from !== undefined && value.to !== undefined;
    case "time_range":
      return isRecord(value) && typeof value.from === "string" && TIME.test(value.from) && typeof value.to === "string" && TIME.test(value.to);
    case "array":
      return Array.isArray(value);
    case "json":
      return true;
    case "point":
      return isRecord(value) && typeof value.lng === "number" && typeof value.lat === "number";
  }
}

/**
 * Every problem with a screen's variables, as messages for the author -
 * empty when they are valid: names, kinds, types, required props, defaults
 * that fit their type, references to variables that exist, and no
 * dependency cycles. Structural only: whether a resource exists and is
 * exposed, or a workflow is MANUAL, is checked by the server against the
 * database. Validation is for the author, not security - the Data API and
 * the function/workflow routes enforce every permission at run time.
 */
export function validateVariables(input: unknown): string[] {
  if (!Array.isArray(input)) return ["Variables must be a list."];
  const errors: string[] = [];
  const names = new Set<string>();
  const dependencies = new Map<string, Set<string>>();

  input.forEach((raw, index) => {
    if (!isRecord(raw)) {
      errors.push(`Variable ${index + 1} is not an object.`);
      return;
    }
    const name = typeof raw.name === "string" ? raw.name : "";
    const label = name || `Variable ${index + 1}`;
    if (!NAME.test(name) || name.length > MAX_NAME_LENGTH) {
      errors.push(`${label}: a name starts with a lowercase letter, then letters, digits or _ (at most ${MAX_NAME_LENGTH}).`);
    } else if (RESERVED_VARIABLE_NAMES.includes(name)) {
      errors.push(`${label}: "${name}" is reserved.`);
    } else if (names.has(name)) {
      errors.push(`${label}: the name is used twice.`);
    }
    names.add(name);

    const references = new Set<string>();
    switch (raw.kind) {
      case "VALUE":
        validateValue(raw, label, errors, references);
        break;
      case "RESOURCE":
        validateResource(raw, label, errors, references);
        break;
      case "CALL":
        validateCall(raw, label, errors, references);
        break;
      case "RECORD":
        errors.push(`${label}: a Record is generated by the DataView type, not defined.`);
        break;
      default:
        errors.push(`${label}: unknown kind "${String(raw.kind)}".`);
    }
    if (raw.kind === "VALUE" || raw.kind === "RESOURCE" || raw.kind === "CALL") validateEmits(raw, raw.kind, label, errors);
    if (name) dependencies.set(name, references);
  });

  for (const [name, references] of dependencies) {
    for (const reference of references) {
      if (IMPLICIT_VARIABLE_NAMES.includes(reference)) continue;
      if (!names.has(reference)) errors.push(`${name}: uses {{vars.${reference}}}, which doesn't exist.`);
      else if (reference === name) errors.push(`${name}: uses itself.`);
    }
  }
  const cycle = findCycle(dependencies);
  if (cycle) errors.push(`These variables depend on each other in a loop: ${cycle.join(" → ")}.`);
  return errors;
}

/** The variables `definition` reads - a Resource reloads when one of them changes (`watch`). */
export function variableDependencies(definition: VariableDefinition): string[] {
  const references = new Set<string>();
  if (definition.kind === "VALUE") {
    if (definition.default?.source === "formula") collectReferences(definition.default.formula, references);
  } else if (definition.kind === "RESOURCE") {
    collectReferences(definition.query, references);
  } else {
    collectReferences(definition.input, references);
  }
  return [...references];
}

/**
 * The columns a Resource's query reads - its `fields`, its `order_by` and
 * every field its `where` names (through `_and`/`_or`/`_not`): what a viewer
 * must be allowed to READ, or the Data API refuses the whole query
 * (DataViews.md §8.3, "All or nothing").
 * Aggregates' aliases aren't columns; `{{vars.*}}` values aren't either.
 */
export function resourceQueryColumns(query: Record<string, unknown>): string[] {
  const columns = new Set<string>();
  const list = (value: unknown) => {
    if (typeof value !== "string") return;
    for (const part of value.split(",")) {
      const column = part.trim().replace(/^-/, "");
      if (column) columns.add(column);
    }
  };
  list(query.fields);
  list(query.order_by);
  const where = (filter: unknown) => {
    if (Array.isArray(filter)) {
      filter.forEach(where);
      return;
    }
    if (!isRecord(filter)) return;
    for (const [key, value] of Object.entries(filter)) {
      if (key === "_and" || key === "_or" || key === "_not") where(value);
      else if (!key.startsWith("_")) columns.add(key);
    }
  };
  where(query.where);
  return [...columns];
}

function validateEmits(raw: Record<string, unknown>, kind: VariableKind, label: string, errors: string[]) {
  if (raw.emits === undefined) return;
  if (!isRecord(raw.emits)) {
    errors.push(`${label}: emits must map an event to a function.`);
    return;
  }
  const known: Readonly<Record<string, VariableEmit>> = VARIABLE_CATALOG[kind].emits;
  for (const [event, handler] of Object.entries(raw.emits)) {
    if (!(event in known)) errors.push(`${label}: a ${VARIABLE_CATALOG[kind].label} has no event "${event}".`);
    else if (typeof handler !== "string" || handler === "") errors.push(`${label}: the "${event}" event has no function.`);
  }
}

function validateValue(raw: Record<string, unknown>, label: string, errors: string[], references: Set<string>) {
  const type = raw.type;
  if (typeof type !== "string" || !isValueType(type)) {
    errors.push(`${label}: unknown value type "${String(type)}".`);
    return;
  }
  const def = raw.default;
  if (def === undefined) return;
  if (!isRecord(def)) {
    errors.push(`${label}: invalid default.`);
    return;
  }
  switch (def.source) {
    case "constant":
      if (!isValidValue(type, def.value)) errors.push(`${label}: the default isn't a valid ${VALUE_TYPE_META[type].label.toLowerCase()}.`);
      break;
    case "formula":
      if (typeof def.formula !== "string" || def.formula.trim() === "") errors.push(`${label}: the default formula is empty.`);
      else collectReferences(def.formula, references);
      break;
    case "param":
      if (typeof def.name !== "string" || def.name === "") errors.push(`${label}: the default URL parameter has no name.`);
      break;
    case "user":
      if (typeof def.field !== "string" || def.field === "") errors.push(`${label}: the default $USER field has no name.`);
      break;
    default:
      errors.push(`${label}: invalid default.`);
  }
}

function validateResource(raw: Record<string, unknown>, label: string, errors: string[], references: Set<string>) {
  if (typeof raw.resource !== "string" || raw.resource === "") errors.push(`${label}: pick a resource.`);
  const query = raw.query;
  if (!isRecord(query)) {
    errors.push(`${label}: the query is missing.`);
  } else {
    if (typeof query.fields !== "string" || query.fields.trim() === "") errors.push(`${label}: the query must list its fields.`);
    collectReferences(query, references);
  }
  if (raw.mode !== "list" && raw.mode !== "record") errors.push(`${label}: mode is list or record.`);
  for (const flag of ["immediate", "watch", "count"] as const) {
    if (typeof raw[flag] !== "boolean") errors.push(`${label}: ${flag} must be true or false.`);
  }
}

function validateCall(raw: Record<string, unknown>, label: string, errors: string[], references: Set<string>) {
  const target = raw.target;
  const valid =
    isRecord(target) &&
    ((target.type === "FUNCTION" && typeof target.resource === "string" && target.resource !== "") ||
      (target.type === "WORKFLOW" && typeof target.workflow === "string" && target.workflow !== "") ||
      (target.type === "TABLE" &&
        typeof target.resource === "string" &&
        target.resource !== "" &&
        (TABLE_CALL_ACTIONS as readonly unknown[]).includes(target.action)));
  if (!valid) errors.push(`${label}: pick a function, a workflow, or a table and what to do (create, update, delete).`);
  if (raw.input !== undefined && !isRecord(raw.input)) errors.push(`${label}: the input must be an object.`);
  // A table update or delete names its rows - never every row by omission.
  if (valid && target.type === "TABLE" && target.action !== "CREATE" && isRecord(raw.input) && raw.input.pk === undefined && raw.input.where === undefined) {
    errors.push(`${label}: a table ${String(target.action).toLowerCase()} names its row - "pk" or "where" in the input.`);
  }
  collectReferences(raw.input, references);
}

/** A page's record settings (`view_config.record`): its events' Code functions. */
export function validateRecordConfig(record: unknown): string[] {
  if (record === undefined) return [];
  if (!isRecord(record)) return ["record: must be an object."];
  const errors: string[] = [];
  validateEmits(record, "RECORD", "record", errors);
  return errors;
}

/** Every `{{vars.<name>` in any string inside `value`. */
function collectReferences(value: unknown, into: Set<string>) {
  if (typeof value === "string") {
    for (const match of value.matchAll(VAR_REFERENCE)) into.add(match[1]!);
  } else if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, into);
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) collectReferences(item, into);
  }
}

/** A dependency loop, as the names along it (first repeated at the end), or null. */
function findCycle(dependencies: Map<string, Set<string>>): string[] | null {
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (name: string): string[] | null => {
    if (state.get(name) === "done") return null;
    if (state.get(name) === "visiting") return [...path.slice(path.indexOf(name)), name];
    state.set(name, "visiting");
    path.push(name);
    for (const next of dependencies.get(name) ?? []) {
      if (next === name || !dependencies.has(next)) continue;
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(name, "done");
    return null;
  };
  for (const name of dependencies.keys()) {
    const cycle = visit(name);
    if (cycle) return cycle;
  }
  return null;
}

