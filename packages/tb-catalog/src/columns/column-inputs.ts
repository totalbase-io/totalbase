/**
 * The column input catalog (Specification_DataViews.md §16): every control a table's column can be edited with, by
 * name - "Number field", "Number with − and +", "Email", "Relation (searchable)" - each with its two faces:
 *
 * - **create** (Add Column): the PostgreSQL column it makes - its data type, CHECK, foreign key;
 * - **recognize** (a column read from PostgreSQL): which facts it takes - its kind of value, a foreign key and to
 *   what, a CHECK list - and, when the column chose none, the one the rule picks (`columnFormInput`: Automatic).
 *
 * A column's choice is its presentation's `input` (a key here) - Add Column stores it, the Columns tab changes it,
 * a view's column inherits it. Unset, the rule decides by type and constraints, never by name. Plain data, no Vue
 * and no `pg`: the admin, the server and the MCP read it. A widget is described once, in WIDGET_CATALOG; an entry
 * only says which one, with which props.
 */

import { checkConstraintBounds } from "./check-bounds.js";
import { checkConstraintArrayValues, checkConstraintValues } from "./check-values.js";
import { checkConstraintPatterns } from "./regex-patterns.js";
import type { ValueKind, WidgetName } from "../widgets/widget-catalog.js";
import { columnValueKind, isFilesForeignKey, type ForeignKeyTarget } from "../widgets/widget-inference.js";

export type FkAction = "NO ACTION" | "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT";

/** A number entry's PostgreSQL type (Add Column): a whole number, a big one, a fixed or a floating decimal. */
export const NUMBER_TYPES = ["integer", "bigint", "decimal", "float"] as const;
export type NumberType = (typeof NUMBER_TYPES)[number];

/** What Add Column's inputs give an entry's DDL - only the keys that change it. */
export interface CreationConfig {
  unique?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  min?: number;
  max?: number;
  /** A number entry's type - its own default when unset. */
  numberType?: NumberType;
  decimals?: number;
  options?: { value: string; label: string }[];
  ratingLength?: number;
  pinLength?: number;
  /** UID strategy only: the column of the same table its value is generated from. */
  uidSource?: string;
  /** Relation strategy only - the modal's target picker; the new column takes the target column's real type. */
  relation?: {
    targetSchema: string;
    targetTable: string;
    targetColumn: string;
    targetColumnDataType: string;
    onDelete?: FkAction;
    onUpdate?: FkAction;
  };
}

export type CreationStrategy =
  | { kind: "scalar"; dataType: string | ((config: CreationConfig) => string) }
  // 'files': always totalbase.files(id); 'guided': target table/column/actions from the modal's picker.
  | { kind: "relation"; target: "files" | "guided" }
  | { kind: "selection"; multiple: boolean }
  // A text column PostgreSQL fills, on write, with the slug of another column (§16.3) - always UNIQUE.
  | { kind: "uid" };

/** The shape `POST /schema/{schema}/tables/{table}/columns` needs beyond name/nullable/default. */
export interface ColumnCreationBody {
  dataType: string;
  check?: string;
  foreignKey?: { targetSchema: string; targetTable: string; targetColumn: string; onDelete?: FkAction; onUpdate?: FkAction };
  uid?: { source: string };
  unique?: boolean;
}

/** What a column's input is recognized from - its PostgreSQL facts. */
export interface ColumnInputFacts {
  name: string;
  dataType: string;
  foreignKey: ForeignKeyTarget | null;
  /** Its table's CHECKs, as PostgreSQL renders them. */
  checks: readonly { expression: string; message: string | null }[];
  /** Its presentation's `input` - the entry chosen for it. */
  input?: string | undefined;
  /** Its presentation's `linkType` - a text column shown as an email, a phone or a URL. */
  linkType?: string | undefined;
}

/** What an entry needs of a column beyond its kind of value. */
type Requirement = "none" | "check-list" | "foreign-key" | "files";

export interface ColumnInputDefinition {
  label: string;
  description: string;
  icon: string;
  /** Add Column's group, and the Columns tab's. */
  group: "text" | "number" | "choice" | "date" | "other" | "relation";
  widget: WidgetName;
  /** The props that make the widget this control - an Input's `type`, an editor's content. */
  props?: Record<string, unknown>;
  // --- recognize ---
  /** The kinds of value it edits. */
  kinds: readonly ValueKind[];
  /** What else the column must have: a CHECK list of values, a foreign key, one to the files. */
  requires?: Requirement;
  // --- create ---
  /** Its DDL - none: it edits a column it can't create (a timestamp range, read from PostgreSQL). */
  create?: CreationStrategy;
  /** A CHECK beyond the data type - null when its config makes none. */
  buildCheckConstraint?: (columnName: string, config: CreationConfig) => string | null;
  /** A number entry: its PostgreSQL type unless Add Column picks another. */
  numberType?: NumberType;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function combineChecks(parts: (string | null | undefined)[]): string | null {
  const present = parts.filter((p): p is string => Boolean(p));
  if (present.length === 0) return null;
  return present.length === 1 ? present[0]! : present.map((p) => `(${p})`).join(" AND ");
}

function textLikeCheck(columnName: string, config: CreationConfig): string | null {
  return combineChecks([
    config.minLength !== undefined ? `length(${columnName}) >= ${config.minLength}` : null,
    config.pattern ? `${columnName} ~ ${quoteLiteral(config.pattern)}` : null,
  ]);
}

function boundsCheck(columnName: string, config: CreationConfig): string | null {
  return combineChecks([
    config.min !== undefined ? `${columnName} >= ${config.min}` : null,
    config.max !== undefined ? `${columnName} <= ${config.max}` : null,
  ]);
}

/** A number entry's data type: its config's type, else its own. */
function numberDataType(fallback: NumberType) {
  return (config: CreationConfig): string => {
    switch (config.numberType ?? fallback) {
      case "bigint":
        return "bigint";
      case "decimal":
        return `numeric(12,${config.decimals ?? 2})`;
      case "float":
        return "double precision";
      default:
        return "integer";
    }
  };
}

const EMAIL_CHECK = (columnName: string) => `${columnName} ~* '^[^@]+@[^@]+\\.[^@]+$'`;
const URL_CHECK = (columnName: string) => `${columnName} ~* '^https?://'`;

export const COLUMN_INPUT_KEYS = [
  "text",
  "long-text",
  "email",
  "url",
  "phone",
  "password",
  "uid",
  "pin",
  "color",
  "scanner",
  "markdown",
  "html",
  "blocks",
  "number-field",
  "number-stepper",
  "slider",
  "rating",
  "choice",
  "choice-radio",
  "choice-search",
  "choice-multiple",
  "tags",
  "switch",
  "checkbox",
  "date",
  "datetime",
  "time",
  "range",
  "json",
  "coordinates",
  "location",
  "relation-search",
  "relation-select",
  "file",
  "photo",
  "signature",
] as const;
export type ColumnInputKey = (typeof COLUMN_INPUT_KEYS)[number];

export const COLUMN_INPUTS: Record<ColumnInputKey, ColumnInputDefinition> = {
  // --- Text ---
  text: {
    label: "Text",
    description: "A line of text - a name, a title, a short label.",
    icon: "i-lucide-type",
    group: "text",
    widget: "UInput",
    kinds: ["text"],
    create: { kind: "scalar", dataType: (config) => (config.maxLength ? `varchar(${config.maxLength})` : "text") },
    buildCheckConstraint: textLikeCheck,
  },
  "long-text": {
    label: "Text (long)",
    description: "Several lines of plain text - a description, a note.",
    icon: "i-lucide-align-left",
    group: "text",
    widget: "UTextarea",
    kinds: ["text", "json"],
    create: { kind: "scalar", dataType: "text" },
    buildCheckConstraint: textLikeCheck,
  },
  email: {
    label: "Email",
    description: "An email address - its field offers the email keyboard; PostgreSQL checks its shape.",
    icon: "i-lucide-at-sign",
    group: "text",
    widget: "UInput",
    props: { type: "email" },
    kinds: ["text"],
    create: { kind: "scalar", dataType: "text" },
    buildCheckConstraint: EMAIL_CHECK,
  },
  url: {
    label: "URL",
    description: "A web address - its field offers the URL keyboard; PostgreSQL checks it starts with http(s).",
    icon: "i-lucide-link",
    group: "text",
    widget: "UInput",
    props: { type: "url" },
    kinds: ["text"],
    create: { kind: "scalar", dataType: "text" },
    buildCheckConstraint: URL_CHECK,
  },
  phone: {
    label: "Phone",
    description: "A phone number - its field offers the phone keypad.",
    icon: "i-lucide-phone",
    group: "text",
    widget: "UInput",
    props: { type: "tel" },
    kinds: ["text"],
    create: { kind: "scalar", dataType: "text" },
    buildCheckConstraint: textLikeCheck,
  },
  password: {
    label: "Password",
    description: "Stored hashed - never returned by the API.",
    icon: "i-lucide-lock",
    group: "text",
    widget: "UInput",
    props: { type: "password" },
    kinds: ["text"],
    // No CHECK: it would run against the stored hash; strength is checked on the server (auth.password_min_length).
    create: { kind: "scalar", dataType: "text" },
  },
  uid: {
    label: "UID",
    description: "A unique slug generated from another column.",
    icon: "i-lucide-fingerprint",
    group: "text",
    widget: "UInput",
    kinds: ["text"],
    create: { kind: "uid" },
  },
  pin: {
    label: "PIN / fixed-length code",
    description: "A short code with a fixed number of characters.",
    icon: "i-lucide-key-round",
    group: "text",
    widget: "UPinInput",
    kinds: ["text"],
    create: { kind: "scalar", dataType: "text" },
    buildCheckConstraint: (columnName, config) => (config.pinLength !== undefined ? `length(${columnName}) = ${config.pinLength}` : null),
  },
  color: {
    label: "Color picker",
    description: "A color, stored as a hex string.",
    icon: "i-lucide-palette",
    group: "text",
    widget: "TColorSelect",
    kinds: ["text"],
    create: { kind: "scalar", dataType: "varchar(7)" },
  },
  scanner: {
    label: "Scanned code",
    description: "Typed, or read with the device's camera - a barcode, a QR, a document's code.",
    icon: "i-lucide-scan-barcode",
    group: "text",
    widget: "TScanner",
    kinds: ["text"],
    create: { kind: "scalar", dataType: "text" },
  },
  markdown: {
    label: "Rich text (Markdown)",
    description: "The classic rich text editor.",
    icon: "i-lucide-file-text",
    group: "text",
    widget: "UEditor",
    props: { contentType: "markdown" },
    kinds: ["text"],
    create: { kind: "scalar", dataType: "text" },
  },
  html: {
    label: "Rich text (HTML)",
    description: "Real HTML markup, like a mailing body.",
    icon: "i-lucide-code",
    group: "text",
    widget: "UEditor",
    props: { contentType: "html" },
    kinds: ["text"],
    create: { kind: "scalar", dataType: "text" },
  },
  blocks: {
    label: "Rich text (Blocks)",
    description: "A structured block-based editor.",
    icon: "i-lucide-layout-list",
    group: "text",
    widget: "UEditor",
    props: { contentType: "json" },
    kinds: ["json"],
    create: { kind: "scalar", dataType: "jsonb" },
  },

  // --- Number ---
  "number-field": {
    label: "Number field",
    description: "Typed freely - an amount, a price, a percentage.",
    icon: "i-lucide-hash",
    group: "number",
    widget: "UInput",
    props: { type: "number" },
    kinds: ["number"],
    numberType: "decimal",
    create: { kind: "scalar", dataType: numberDataType("decimal") },
    buildCheckConstraint: boundsCheck,
  },
  "number-stepper": {
    label: "Number with − and +",
    description: "Steps through whole numbers - a quantity, a count.",
    icon: "i-lucide-diff",
    group: "number",
    widget: "UInputNumber",
    kinds: ["number"],
    numberType: "integer",
    create: { kind: "scalar", dataType: numberDataType("integer") },
    buildCheckConstraint: boundsCheck,
  },
  slider: {
    label: "Slider",
    description: "A number picked along a bounded range.",
    icon: "i-lucide-sliders-horizontal",
    group: "number",
    widget: "USlider",
    kinds: ["number"],
    create: { kind: "scalar", dataType: "numeric" },
    buildCheckConstraint: (columnName, config) => (config.min !== undefined && config.max !== undefined ? `${columnName} BETWEEN ${config.min} AND ${config.max}` : null),
  },
  rating: {
    label: "Rating",
    description: "A star rating out of a fixed maximum.",
    icon: "i-lucide-star",
    group: "number",
    widget: "UInputRating",
    kinds: ["number"],
    create: { kind: "scalar", dataType: "smallint" },
    buildCheckConstraint: (columnName, config) => `${columnName} BETWEEN 1 AND ${config.ratingLength ?? 5}`,
  },

  // --- Choice: a CHECK list of values ---
  choice: {
    label: "Choice",
    description: "One value of a fixed list, from a select.",
    icon: "i-lucide-chevron-down-square",
    group: "choice",
    widget: "USelect",
    kinds: ["text", "number"],
    requires: "check-list",
    create: { kind: "selection", multiple: false },
    buildCheckConstraint: (columnName, config) => (config.options?.length ? `${columnName} IN (${config.options.map((o) => quoteLiteral(o.value)).join(", ")})` : null),
  },
  "choice-radio": {
    label: "Choice (buttons)",
    description: "One value of a fixed list, each in sight.",
    icon: "i-lucide-circle-dot",
    group: "choice",
    widget: "URadioGroup",
    kinds: ["text", "number"],
    requires: "check-list",
    create: { kind: "selection", multiple: false },
    buildCheckConstraint: (columnName, config) => (config.options?.length ? `${columnName} IN (${config.options.map((o) => quoteLiteral(o.value)).join(", ")})` : null),
  },
  "choice-search": {
    label: "Choice (searchable)",
    description: "One value of a long fixed list, typed to find it.",
    icon: "i-lucide-text-search",
    group: "choice",
    widget: "USelectMenu",
    kinds: ["text", "number"],
    requires: "check-list",
    create: { kind: "selection", multiple: false },
    buildCheckConstraint: (columnName, config) => (config.options?.length ? `${columnName} IN (${config.options.map((o) => quoteLiteral(o.value)).join(", ")})` : null),
  },
  "choice-multiple": {
    label: "Choice (multiple)",
    description: "Any number of values of a fixed list.",
    icon: "i-lucide-list-todo",
    group: "choice",
    widget: "UCheckboxGroup",
    kinds: ["array"],
    requires: "check-list",
    create: { kind: "selection", multiple: true },
    buildCheckConstraint: (columnName, config) => (config.options?.length ? `${columnName} <@ ARRAY[${config.options.map((o) => quoteLiteral(o.value)).join(", ")}]` : null),
  },
  tags: {
    label: "Tags",
    description: "A free list of short text values.",
    icon: "i-lucide-tags",
    group: "choice",
    widget: "UInputTags",
    kinds: ["array"],
    create: { kind: "scalar", dataType: "text[]" },
  },
  switch: {
    label: "Switch",
    description: "Yes or no.",
    icon: "i-lucide-toggle-left",
    group: "choice",
    widget: "USwitch",
    kinds: ["boolean"],
    create: { kind: "scalar", dataType: "boolean" },
  },
  checkbox: {
    label: "Checkbox",
    description: "Yes or no, ticked.",
    icon: "i-lucide-square-check",
    group: "choice",
    widget: "UCheckbox",
    kinds: ["boolean"],
    create: { kind: "scalar", dataType: "boolean" },
  },

  // --- Date and time ---
  date: {
    label: "Date",
    description: "A calendar date, no time of day.",
    icon: "i-lucide-calendar",
    group: "date",
    widget: "UInputDate",
    kinds: ["date"],
    create: { kind: "scalar", dataType: "date" },
  },
  datetime: {
    label: "Date and time",
    description: "A moment - shown and picked in the viewer's time zone.",
    icon: "i-lucide-calendar-clock",
    group: "date",
    widget: "UInputDate",
    kinds: ["timestamp"],
    create: { kind: "scalar", dataType: "timestamptz" },
  },
  time: {
    label: "Time",
    description: "A time of day, no date.",
    icon: "i-lucide-clock",
    group: "date",
    widget: "UInputTime",
    kinds: ["time"],
    create: { kind: "scalar", dataType: "time" },
  },
  range: {
    label: "Range",
    description: "From and To - a period, a span of numbers (a PostgreSQL range).",
    icon: "i-lucide-move-horizontal",
    group: "date",
    widget: "TRangeInput",
    kinds: ["range"],
  },

  // --- Other ---
  json: {
    label: "JSON",
    description: "Structured data in JSON format.",
    icon: "i-lucide-braces",
    group: "other",
    widget: "TJson",
    kinds: ["json"],
    create: { kind: "scalar", dataType: "jsonb" },
  },
  coordinates: {
    label: "Coordinates",
    description: "A map pin (latitude/longitude).",
    icon: "i-lucide-map-pin",
    group: "other",
    widget: "TLeafletMap",
    kinds: ["point"],
    create: { kind: "scalar", dataType: "point" },
  },
  location: {
    label: "Location",
    description: "The device's position, no map - where a record was made.",
    icon: "i-lucide-locate-fixed",
    group: "other",
    widget: "TGeolocation",
    kinds: ["point"],
    create: { kind: "scalar", dataType: "point" },
  },

  // --- Relations: a foreign key ---
  "relation-search": {
    label: "Relation (searchable)",
    description: "A row of another table, typed to find it.",
    icon: "i-lucide-search",
    group: "relation",
    widget: "USelectMenu",
    kinds: ["relation"],
    requires: "foreign-key",
    create: { kind: "relation", target: "guided" },
  },
  "relation-select": {
    label: "Relation",
    description: "A row of another table, from a select - for a short table.",
    icon: "i-lucide-link-2",
    group: "relation",
    widget: "USelect",
    kinds: ["relation"],
    requires: "foreign-key",
    create: { kind: "relation", target: "guided" },
  },
  file: {
    label: "File",
    description: "A single uploaded file or image.",
    icon: "i-lucide-file-up",
    group: "relation",
    widget: "UFileUpload",
    kinds: ["file"],
    requires: "files",
    create: { kind: "relation", target: "files" },
  },
  photo: {
    label: "Photo",
    description: "Taken with the device's camera.",
    icon: "i-lucide-camera",
    group: "relation",
    widget: "TCamera",
    kinds: ["file"],
    requires: "files",
    create: { kind: "relation", target: "files" },
  },
  signature: {
    label: "Signature",
    description: "Drawn by hand, saved as an image.",
    icon: "i-lucide-signature",
    group: "relation",
    widget: "TSignature",
    kinds: ["file"],
    requires: "files",
    create: { kind: "relation", target: "files" },
  },
};

export function isColumnInputKey(value: unknown): value is ColumnInputKey {
  return typeof value === "string" && (COLUMN_INPUT_KEYS as readonly string[]).includes(value);
}

export function columnInputDefinition(key: ColumnInputKey): ColumnInputDefinition {
  return COLUMN_INPUTS[key];
}

/** The entries Add Column offers - those that create their column. */
export function creatableColumnInputs(): ColumnInputKey[] {
  return COLUMN_INPUT_KEYS.filter((key) => COLUMN_INPUTS[key].create !== undefined);
}

// --- Recognize --------------------------------------------------------------

/** A column's facts that entries are matched against - computed once. */
function readFacts(facts: ColumnInputFacts) {
  const kind = columnValueKind(facts.dataType, facts.foreignKey);
  const expressions = facts.checks.map((c) => c.expression);
  const list = facts.foreignKey ? null : kind === "array" ? checkConstraintArrayValues(facts.name, expressions) : checkConstraintValues(facts.name, expressions);
  return { kind, list };
}

/** Whether an entry edits this column: its kind of value, and what else it requires. */
function accepts(key: ColumnInputKey, kind: ValueKind, hasList: boolean): boolean {
  const entry = COLUMN_INPUTS[key];
  if (!entry.kinds.includes(kind)) return false;
  switch (entry.requires) {
    case "check-list":
      return hasList;
    default:
      return true;
  }
}

/** Every entry that can edit this column - what its Input select offers. */
export function columnInputsFor(facts: ColumnInputFacts): ColumnInputKey[] {
  const { kind, list } = readFacts(facts);
  return COLUMN_INPUT_KEYS.filter((key) => accepts(key, kind, list !== null));
}

/**
 * Why a column gets its input: chosen for it (Add Column, the Columns tab), a file's or a relation's foreign key,
 * a CHECK list, a whole number in a small CHECK range, any other number, what its link type or CHECK pattern says
 * of a text, or its type's own.
 */
export type ColumnInputReason = "chosen" | "file" | "relation" | "check-list" | "small-range" | "number" | "link-type" | "pattern" | "default";

/** A column's input: the catalog entry, its widget and props, and why. */
export interface ColumnFormInput {
  input: ColumnInputKey;
  widget: WidgetName;
  props: Record<string, unknown>;
  reason: ColumnInputReason;
}

/** The widest CHECK range (max − min) a whole number still gets − and + to step through (1..12, 0..100). */
export const SMALL_RANGE = 100;

const INTEGER = /^(smallint|integer|bigint)$/;
const EMAIL_PATTERN = /@/;
const URL_PATTERN = /^\^?https?|\^\(?https?/i;

function asInput(key: ColumnInputKey, reason: ColumnInputReason): ColumnFormInput {
  const entry = COLUMN_INPUTS[key];
  return { input: key, widget: entry.widget, props: { ...entry.props }, reason };
}

/**
 * The input a column is edited with in a form (Specification_DataViews.md §15.2): its chosen entry when it still
 * edits the column, else the rule's - a file's foreign key a file upload, any other foreign key a searchable
 * relation, a CHECK list a select (a text[]'s, checkboxes), a whole number in a CHECK range at most SMALL_RANGE wide
 * − and +, any other number a number field, a text an email's, a phone's or a URL's field by its link type or CHECK
 * pattern, else its type's own. By type and constraints, never by name - one rule for the server, the Design form,
 * the wizard and the MCP.
 */
export function columnFormInput(facts: ColumnInputFacts): ColumnFormInput {
  const { kind, list } = readFacts(facts);
  if (isColumnInputKey(facts.input) && accepts(facts.input, kind, list !== null)) return asInput(facts.input, "chosen");
  return asInput(...automaticInput(facts, kind, list !== null));
}

function automaticInput(facts: ColumnInputFacts, kind: ValueKind, hasList: boolean): [ColumnInputKey, ColumnInputReason] {
  if (isFilesForeignKey(facts.foreignKey)) return ["file", "file"];
  if (facts.foreignKey) return ["relation-search", "relation"];
  if (hasList) return kind === "array" ? ["choice-multiple", "check-list"] : ["choice", "check-list"];
  switch (kind) {
    case "number": {
      const range = integerRange(facts.name, facts.dataType, facts.checks);
      return range && range.max - range.min <= SMALL_RANGE ? ["number-stepper", "small-range"] : ["number-field", "number"];
    }
    case "text": {
      if (facts.linkType === "email") return ["email", "link-type"];
      if (facts.linkType === "tel") return ["phone", "link-type"];
      if (facts.linkType === "url") return ["url", "link-type"];
      const patterns = checkConstraintPatterns(facts.name, facts.checks);
      if (patterns.some((p) => EMAIL_PATTERN.test(p.source))) return ["email", "pattern"];
      if (patterns.some((p) => URL_PATTERN.test(p.source))) return ["url", "pattern"];
      return ["text", "default"];
    }
    default:
      return [KIND_INPUTS[kind], "default"];
  }
}

/**
 * The entry a kind of value gets when nothing else decides (no foreign key, no CHECK list, no pattern): the rule's
 * last word. A number's and a text's go through automaticInput's own cases first. `date_range` and `time_range` are
 * never a column's kind - a Value variable's (variable-catalog.ts) - and take the pickers of their bounds.
 */
export const KIND_INPUTS: Record<ValueKind, ColumnInputKey> = {
  text: "text",
  number: "number-field",
  boolean: "switch",
  date: "date",
  time: "time",
  timestamp: "datetime",
  json: "json",
  point: "coordinates",
  range: "range",
  array: "tags",
  relation: "relation-search",
  file: "file",
  date_range: "date",
  time_range: "time",
};

/**
 * The widget a kind of value gets by default - derived from KIND_INPUTS, so a grid column, a form field and a
 * variable's control all follow the one catalog (Specification_DataViews.md §16.1). A column's own default goes
 * through `columnFormInput` (its foreign key, CHECK list and pattern count); this is the kind's alone.
 */
export const DEFAULT_WIDGETS: Record<ValueKind, WidgetName> = Object.fromEntries(
  Object.entries(KIND_INPUTS).map(([kind, key]) => [kind, COLUMN_INPUTS[key].widget]),
) as Record<ValueKind, WidgetName>;

/** A whole number's CHECK range - both ends, inclusive (`> 0` is `>= 1`) - or null when it has no two. */
export function integerRange(column: string, dataType: string, checks: ColumnInputFacts["checks"]): { min: number; max: number } | null {
  if (!INTEGER.test(dataType.toLowerCase())) return null;
  let min: number | undefined;
  let max: number | undefined;
  for (const bound of checkConstraintBounds(column, checks)) {
    if (bound.kind !== "value") continue;
    if (bound.op === ">=" || bound.op === ">") {
      const low = bound.op === ">" ? Math.floor(bound.value) + 1 : Math.ceil(bound.value);
      min = min === undefined ? low : Math.max(min, low);
    } else {
      const high = bound.op === "<" ? Math.ceil(bound.value) - 1 : Math.floor(bound.value);
      max = max === undefined ? high : Math.min(max, high);
    }
  }
  return min !== undefined && max !== undefined ? { min, max } : null;
}

// --- Create -----------------------------------------------------------------

/**
 * An entry and its config as the exact shape `POST /schema/{schema}/tables/{table}/columns` needs beyond name/
 * nullable/default. A relation entry needs `config.relation` from the modal's picker - a relation with no foreign
 * key is a bug, so it throws.
 */
export function buildColumnCreationBody(key: ColumnInputKey, columnName: string, config: CreationConfig): ColumnCreationBody {
  const entry = COLUMN_INPUTS[key];
  const strategy = entry.create;
  if (!strategy) throw new Error(`${key} edits a column it doesn't create`);

  if (strategy.kind === "relation") {
    if (strategy.target === "files") {
      return { dataType: "uuid", foreignKey: { targetSchema: "totalbase", targetTable: "files", targetColumn: "id" } };
    }
    if (!config.relation) throw new Error(`${key} is a relation but no target was chosen`);
    return {
      dataType: config.relation.targetColumnDataType,
      foreignKey: {
        targetSchema: config.relation.targetSchema,
        targetTable: config.relation.targetTable,
        targetColumn: config.relation.targetColumn,
        ...(config.relation.onDelete !== undefined ? { onDelete: config.relation.onDelete } : {}),
        ...(config.relation.onUpdate !== undefined ? { onUpdate: config.relation.onUpdate } : {}),
      },
    };
  }
  if (strategy.kind === "uid") {
    if (!config.uidSource) throw new Error("uid is generated from another column but none was chosen");
    return { dataType: "text", unique: true, uid: { source: config.uidSource } };
  }
  if (strategy.kind === "selection") {
    const dataType = strategy.multiple ? "text[]" : "text";
    const check = entry.buildCheckConstraint?.(columnName, config);
    return { dataType, ...(check ? { check } : {}) };
  }
  const dataType = typeof strategy.dataType === "function" ? strategy.dataType(config) : strategy.dataType;
  const check = entry.buildCheckConstraint?.(columnName, config);
  return { dataType, ...(check ? { check } : {}) };
}

export function creationStrategyFor(key: ColumnInputKey): CreationStrategy | undefined {
  return COLUMN_INPUTS[key].create;
}
