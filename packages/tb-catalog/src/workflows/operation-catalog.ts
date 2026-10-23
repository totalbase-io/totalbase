import { describeShape, distinct, isRecord, type Shape } from "@totalbase/shared";

/**
 * The workflow operation catalog (Workflows.md §5, §5.25): every step a workflow can hold, and the
 * one description of it - the editor's step menu, its canvas ports, the server's save and publish checks, the
 * engine's template resolution and the MCP's guide all read it. Plain data, no `pg`: the runtime handlers stay in
 * `@totalbase/workflows` (`OPERATION_HANDLERS`), which a test keeps equal to the entries that run as a handler.
 *
 * Each entry says what the operation is (label, icon, group), how the graph meets it (its output ports), how its
 * configuration is read (templates resolved or literal), what it can't be published without, and the shape its
 * configuration may hold - every field optional on a draft (incomplete is valid draft content, §3.5), never a
 * field it doesn't have nor a value of the wrong kind.
 *
 * Configuration keys keep the stored document's own names (§3.1): camelCase for the operations', snake_case for a
 * Start's trigger. Start's configuration is its trigger (§6), checked by the publish readiness, not described here.
 */

/** The step menu's groups, in its order. */
export const OPERATION_GROUPS = [
  { key: "data", label: "Data" },
  { key: "control", label: "Control" },
  { key: "code", label: "Code" },
  { key: "integration", label: "Integration" },
  { key: "communication", label: "Communication" },
  { key: "files", label: "Files" },
  { key: "documents", label: "Documents" },
  { key: "composition", label: "Composition" },
] as const;

export type OperationGroup = (typeof OPERATION_GROUPS)[number]["key"];

/** A resource kind a step may name (`resources.type`). */
export type OperationResourceType = "TABLE" | "VIEW" | "FUNCTION";

/** A piece of configuration a step can't be published without (§3.5) - one line of `WORKFLOW_NOT_PUBLISHABLE`. */
export interface OperationRequirement {
  /** The field, or several of which any one will do (a subject or a template). */
  field: string | readonly string[];
  /** The issue, in the editor's words ("no table"). */
  missing: string;
  /** An empty text counts as set (a file's content may be empty). */
  allowEmpty?: boolean;
  /** Only when another field holds one of these values - `undefined` for unset (Sign's certificate is CMS's, not HMAC's). */
  when?: { field: string; is: readonly (string | undefined)[] };
}

export interface OperationDefinition {
  /** The stored `type`. */
  type: string;
  /** Its group in the step menu; null for Start, which is never added. */
  group: OperationGroup | null;
  icon: string;
  /** English label and description - the admin's fallback for `workflows.catalog.operations.<type>.label|description`. */
  label: string;
  description: string;
  /** Who runs it: a handler (`OPERATION_HANDLERS`), or the engine itself - Start and the loops (§5.11, §5.12). */
  runs: "handler" | "engine";
  /**
   * Its output ports (§3.3), in the canvas's order, `error` included where it has one; empty for a terminal step.
   * A Select case adds each configured case's name, and `default` when enabled, before its `error`.
   */
  outputs: readonly string[];
  /** A loop's body entry - the port whose subtree runs per item (§3.4). */
  bodyOutput?: "item" | "batch";
  /**
   * Which configuration the engine resolves `{{...}}` templates in before the step runs (§4.3): all of it, only the
   * named fields (a loop's list), or none - Execute SQL, Execute JavaScript and Wait take theirs literally.
   */
  templates: "configuration" | readonly string[] | "none";
  /** The resource a step names, resolved by id at publish and at run time (§5.1). */
  resource?: { field: string; types: readonly OperationResourceType[]; noun: string };
  /** What it can't be published without (§3.5). */
  required: readonly OperationRequirement[];
  /** What its configuration may hold - checked on every save (§3.5). */
  configuration: Shape;
}

/** Exactly one `{{path}}` - a value a template resolves to whole (§4.2), standing in for a value of any kind. */
const TEMPLATE_EXPRESSION = /^\s*\{\{\s*[^{}]+?\s*\}\}\s*$/;
const TEMPLATE: Shape = {
  type: "custom",
  takes: "a {{template}}",
  check: (value) => (typeof value === "string" && TEMPLATE_EXPRESSION.test(value) ? null : "is not a {{template}}"),
};

/** The value, or a template resolving to one - for a templated operation's non-text fields. */
function bound(shape: Shape): Shape {
  return { type: "oneOf", forms: [shape, TEMPLATE], label: `${describeShape(shape)} or a {{template}}` };
}

const TEXT: Shape = { type: "text" };
const ANY: Shape = { type: "any" };
const BOOLEAN: Shape = { type: "boolean" };
/** A JSON object of any fields - a record's values, a function's arguments, a PDF's data. */
const OBJECT: Shape = { type: "custom", takes: "an object", check: (value) => (isRecord(value) ? null : "is not an object") };
/** A filter object in the one filter grammar (Data_API.md §3), parsed where it's used. */
const FILTER: Shape = { type: "custom", takes: "a filter object", check: (value) => (isRecord(value) ? null : "is not a filter object") };
/** One address, several comma-separated, or a list of them (§5.16). */
const ADDRESSES: Shape = { type: "oneOf", forms: [TEXT, { type: "list", of: TEXT }], label: "an address, a comma-separated list or a list of addresses" };
const CSV_OR_JSON: Shape = { type: "enum", options: ["json", "csv"] };

/** A Data API query object - its top-level clauses (Data_API.md §3), each read by the query parser. */
const QUERY: Shape = {
  type: "object",
  fields: Object.fromEntries(
    ["fields", "where", "search", "search_fields", "group_by", "having", "order_by", "limit", "offset", "count", "flags", "_sum", "_count", "_avg", "_min", "_max"].map((clause) => [clause, ANY]),
  ),
};

/** A Select case's name: a lowercase identifier, never one of the ports every step has (§5.10). */
const CASE_OUTPUT: Shape = {
  type: "custom",
  takes: "a lowercase identifier",
  check: (value) => {
    if (typeof value !== "string" || !/^[a-z][a-z0-9_]*$/.test(value)) return "is not a lowercase identifier (letters, digits and _)";
    return value === "default" || value === "error" || value === "next" ? `can't be "${value}"` : null;
  },
};

const RECORD_RESOURCE = { field: "resource", types: ["TABLE"], noun: "table" } as const;
const NEXT_ERROR = ["next", "error"] as const;

const CATALOG = [
  {
    type: "totalbase.start",
    group: null,
    icon: "i-lucide-play",
    label: "Start",
    description: "The trigger the workflow starts from",
    runs: "engine",
    outputs: ["next"],
    templates: "none",
    required: [],
    configuration: OBJECT,
  },
  // Data
  {
    type: "totalbase.read-records",
    group: "data",
    icon: "i-lucide-search",
    label: "Read records",
    description: "Query a resource",
    runs: "handler",
    outputs: NEXT_ERROR,
    templates: "configuration",
    resource: { field: "resource", types: ["TABLE", "VIEW"], noun: "table" },
    required: [{ field: "resource", missing: "no table or view" }],
    configuration: { type: "object", fields: { resource: TEXT, query: bound(QUERY) } },
  },
  {
    type: "totalbase.create-records",
    group: "data",
    icon: "i-lucide-circle-plus",
    label: "Create records",
    description: "Insert one or more records",
    runs: "handler",
    outputs: NEXT_ERROR,
    templates: "configuration",
    resource: RECORD_RESOURCE,
    required: [{ field: "resource", missing: "no table" }, { field: "records", missing: "no records to create" }],
    configuration: { type: "object", fields: { resource: TEXT, records: bound({ type: "list", of: ANY }), emitEvents: bound(BOOLEAN) } },
  },
  {
    type: "totalbase.update-records",
    group: "data",
    icon: "i-lucide-pencil",
    label: "Update records",
    description: "Modify a selection",
    runs: "handler",
    outputs: NEXT_ERROR,
    templates: "configuration",
    resource: RECORD_RESOURCE,
    required: [{ field: "resource", missing: "no table" }, { field: "set", missing: "no values to set" }],
    configuration: { type: "object", fields: { resource: TEXT, where: bound(FILTER), set: bound(OBJECT), emitEvents: bound(BOOLEAN) } },
  },
  {
    type: "totalbase.delete-records",
    group: "data",
    icon: "i-lucide-trash-2",
    label: "Delete records",
    description: "Delete a selection",
    runs: "handler",
    outputs: NEXT_ERROR,
    templates: "configuration",
    resource: RECORD_RESOURCE,
    required: [{ field: "resource", missing: "no table" }],
    configuration: { type: "object", fields: { resource: TEXT, where: bound(FILTER), emitEvents: bound(BOOLEAN) } },
  },
  // Control
  {
    type: "totalbase.condition",
    group: "control",
    icon: "i-lucide-split",
    label: "Condition",
    description: "Branch on a filter",
    runs: "handler",
    outputs: ["true", "false", "error"],
    templates: "configuration",
    required: [],
    configuration: { type: "object", fields: { input: ANY, filter: bound(FILTER) } },
  },
  {
    type: "totalbase.for-each",
    group: "control",
    icon: "i-lucide-repeat",
    label: "For each item",
    description: "Run a block per list item",
    runs: "engine",
    outputs: ["item", "done", "error"],
    bodyOutput: "item",
    templates: ["items"],
    required: [],
    configuration: { type: "object", fields: { items: bound({ type: "list", of: ANY }) } },
  },
  {
    type: "totalbase.select-case",
    group: "control",
    icon: "i-lucide-git-branch",
    label: "Select case",
    description: "Choose among branches",
    runs: "handler",
    outputs: ["error"],
    templates: "configuration",
    required: [],
    configuration: {
      type: "object",
      fields: {
        input: ANY,
        cases: { type: "list", of: { type: "object", fields: { output: CASE_OUTPUT, filter: bound(FILTER) }, required: ["output"] }, check: distinct("the case", "output") },
        hasDefault: bound(BOOLEAN),
      },
    },
  },
  {
    type: "totalbase.finish-error",
    group: "control",
    icon: "i-lucide-octagon-x",
    label: "Finish with error",
    description: "Stop with a defined error",
    runs: "handler",
    outputs: [],
    templates: "configuration",
    required: [],
    configuration: { type: "object", fields: { code: TEXT, message: TEXT } },
  },
  {
    type: "totalbase.finish-result",
    group: "control",
    icon: "i-lucide-flag",
    label: "Finish with result",
    description: "Stop with an explicit result",
    runs: "handler",
    outputs: [],
    templates: "configuration",
    required: [],
    configuration: { type: "object", fields: { result: ANY } },
  },
  {
    type: "totalbase.validate-data",
    group: "control",
    icon: "i-lucide-shield-check",
    label: "Validate data",
    description: "Check fields, types, conditions",
    runs: "handler",
    outputs: NEXT_ERROR,
    templates: "configuration",
    required: [{ field: "rules", missing: "no rules" }],
    configuration: { type: "object", fields: { input: ANY, rules: { type: "list", of: { type: "object", fields: { filter: bound(FILTER), message: TEXT } } } } },
  },
  // Code
  {
    type: "totalbase.execute-function",
    group: "code",
    icon: "i-lucide-function-square",
    label: "Execute function",
    description: "Invoke a PostgreSQL function",
    runs: "handler",
    outputs: NEXT_ERROR,
    templates: "configuration",
    resource: { field: "function", types: ["FUNCTION"], noun: "function" },
    required: [{ field: "function", missing: "no function" }],
    configuration: { type: "object", fields: { function: TEXT, arguments: bound(OBJECT) } },
  },
  {
    type: "totalbase.execute-javascript",
    group: "code",
    icon: "i-lucide-code",
    label: "Execute JavaScript",
    description: "Custom logic/transformation",
    runs: "handler",
    outputs: NEXT_ERROR,
    templates: "none",
    required: [{ field: "code", missing: "no code" }],
    configuration: { type: "object", fields: { code: TEXT } },
  },
  {
    type: "totalbase.execute-sql",
    group: "code",
    icon: "i-lucide-terminal",
    label: "Execute SQL",
    description: "Run a statement as a chosen user (audit only - no permission checks)",
    runs: "handler",
    outputs: NEXT_ERROR,
    templates: "none",
    // executeAs defaults to the run's executor (Workflows.md §5.7).
    required: [{ field: "statement", missing: "no SQL statement" }],
    configuration: { type: "object", fields: { statement: TEXT, executeAs: TEXT } },
  },
  // Integration
  {
    type: "totalbase.http-request",
    group: "integration",
    icon: "i-lucide-route",
    label: "HTTP request",
    description: "Call an external API",
    runs: "handler",
    outputs: NEXT_ERROR,
    templates: "configuration",
    required: [{ field: "url", missing: "no URL" }],
    configuration: {
      type: "object",
      fields: {
        method: bound({ type: "enum", options: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] }),
        url: TEXT,
        headers: bound(OBJECT),
        secretHeaders: { type: "list", of: { type: "object", fields: { name: TEXT, secret: TEXT }, required: ["name", "secret"] } },
        body: ANY,
      },
    },
  },
  {
    type: "totalbase.soap-request",
    group: "integration",
    icon: "i-lucide-code-xml",
    label: "SOAP request",
    description: "Call a SOAP web service",
    runs: "handler",
    outputs: NEXT_ERROR,
    templates: "configuration",
    required: [{ field: "url", missing: "no URL" }, { field: "operation", missing: "no operation" }, { field: "namespace", missing: "no namespace" }],
    configuration: {
      type: "object",
      fields: {
        url: TEXT,
        version: bound({ type: "enum", options: ["1.1", "1.2"] }),
        operation: TEXT,
        namespace: TEXT,
        soapAction: TEXT,
        body: bound(OBJECT),
        soapHeaders: bound(OBJECT),
        httpHeaders: bound(OBJECT),
        secretHeaders: { type: "list", of: { type: "object", fields: { name: TEXT, secret: TEXT }, required: ["name", "secret"] } },
        arrays: { type: "list", of: TEXT },
      },
    },
  },
  {
    type: "totalbase.sign",
    group: "integration",
    icon: "i-lucide-signature",
    label: "Sign",
    description: "Sign data with a stored certificate or key",
    runs: "handler",
    outputs: NEXT_ERROR,
    templates: "configuration",
    required: [
      { field: "data", missing: "no data" },
      { field: "certificate", missing: "no certificate", when: { field: "format", is: [undefined, "CMS"] } },
      { field: "privateKey", missing: "no private key", when: { field: "format", is: [undefined, "CMS"] } },
      { field: "key", missing: "no key", when: { field: "format", is: ["HMAC_SHA256"] } },
    ],
    configuration: {
      type: "object",
      fields: {
        format: { type: "enum", options: ["CMS", "HMAC_SHA256"] },
        data: TEXT,
        certificate: TEXT,
        privateKey: TEXT,
        passphrase: TEXT,
        key: TEXT,
        encoding: { type: "enum", options: ["HEX", "BASE64"] },
      },
    },
  },
  // Communication
  {
    type: "totalbase.send-email",
    group: "communication",
    icon: "i-lucide-mail",
    label: "Send email",
    description: "Send a message",
    runs: "handler",
    outputs: NEXT_ERROR,
    templates: "configuration",
    required: [{ field: "to", missing: "no recipient" }, { field: ["template", "subject"], missing: "no subject or template" }],
    configuration: {
      type: "object",
      fields: {
        to: ADDRESSES,
        cc: ADDRESSES,
        bcc: ADDRESSES,
        replyTo: TEXT,
        template: TEXT,
        data: bound(OBJECT),
        subject: TEXT,
        bodyType: bound({ type: "enum", options: ["text", "html", "both"] }),
        textBody: TEXT,
        htmlBody: TEXT,
        attachments: { type: "oneOf", forms: [TEXT, { type: "list", of: TEXT }], label: "a file id, a {{template}} or a list of them" },
      },
    },
  },
  // Files
  {
    type: "totalbase.read-file",
    group: "files",
    icon: "i-lucide-file-text",
    label: "Read file",
    description: "Read an existing Asset",
    runs: "handler",
    outputs: NEXT_ERROR,
    templates: "configuration",
    required: [{ field: "asset", missing: "no file" }],
    configuration: { type: "object", fields: { asset: TEXT } },
  },
  {
    type: "totalbase.create-file",
    group: "files",
    icon: "i-lucide-file-plus",
    label: "Create file",
    description: "Store generated content",
    runs: "handler",
    outputs: NEXT_ERROR,
    templates: "configuration",
    required: [{ field: "name", missing: "no file name" }, { field: "content", missing: "no content", allowEmpty: true }],
    configuration: { type: "object", fields: { name: TEXT, contentType: TEXT, content: TEXT, encoding: bound({ type: "enum", options: ["text", "base64"] }), folder: TEXT } },
  },
  {
    type: "totalbase.parse-file",
    group: "files",
    icon: "i-lucide-file-input",
    label: "Parse CSV / JSON",
    description: "Convert content into data",
    runs: "handler",
    outputs: NEXT_ERROR,
    templates: "configuration",
    required: [{ field: "asset", missing: "no file" }],
    configuration: { type: "object", fields: { asset: TEXT, format: bound(CSV_OR_JSON) } },
  },
  {
    type: "totalbase.generate-file",
    group: "files",
    icon: "i-lucide-file-output",
    label: "Generate CSV / JSON",
    description: "Serialize data for export",
    runs: "handler",
    outputs: NEXT_ERROR,
    templates: "configuration",
    required: [],
    configuration: { type: "object", fields: { format: bound(CSV_OR_JSON), data: ANY } },
  },
  // Documents
  {
    type: "totalbase.generate-pdf-template",
    group: "documents",
    icon: "i-lucide-file-text",
    label: "Generate PDF from template",
    description: "Fill a saved pdfme template",
    runs: "handler",
    outputs: NEXT_ERROR,
    templates: "configuration",
    required: [{ field: "template", missing: "no PDF template" }],
    configuration: { type: "object", fields: { template: TEXT, data: bound(OBJECT) } },
  },
  {
    type: "totalbase.generate-pdf",
    group: "documents",
    icon: "i-lucide-file-output",
    label: "Generate PDF",
    description: "Build a PDF from a custom layout",
    runs: "handler",
    outputs: NEXT_ERROR,
    templates: "configuration",
    required: [{ field: "design", missing: "no PDF design" }],
    configuration: { type: "object", fields: { design: bound(OBJECT), data: bound(OBJECT) } },
  },
  // Composition
  {
    type: "totalbase.execute-workflow",
    group: "composition",
    icon: "i-lucide-workflow",
    label: "Execute another workflow",
    description: "Reuse a process",
    runs: "handler",
    outputs: NEXT_ERROR,
    templates: "configuration",
    required: [{ field: "workflow", missing: "no workflow" }],
    configuration: { type: "object", fields: { workflow: TEXT, input: ANY } },
  },
  {
    type: "totalbase.wait-resume",
    group: "composition",
    icon: "i-lucide-clock",
    label: "Wait",
    description: "Pause for a fixed time",
    runs: "handler",
    outputs: NEXT_ERROR,
    templates: "none",
    required: [{ field: "waitSeconds", missing: "no wait time" }],
    configuration: { type: "object", fields: { waitSeconds: { type: "number", check: (value) => ((value as number) > 0 ? null : "is more than 0 seconds") } } },
  },
  {
    type: "totalbase.process-batches",
    group: "composition",
    icon: "i-lucide-boxes",
    label: "Process in batches",
    description: "Split a collection into fixed-size batches",
    runs: "engine",
    outputs: ["batch", "done", "error"],
    bodyOutput: "batch",
    templates: ["source"],
    required: [],
    configuration: { type: "object", fields: { source: bound({ type: "list", of: ANY }), batchSize: { type: "number", integer: true, min: 1 } } },
  },
] as const satisfies readonly OperationDefinition[];

/** Every operation type TotalBase has. */
export type OperationType = (typeof CATALOG)[number]["type"];

export const OPERATION_CATALOG: readonly (OperationDefinition & { type: OperationType })[] = CATALOG;


const BY_TYPE = new Map<string, OperationDefinition>(OPERATION_CATALOG.map((definition) => [definition.type, definition]));

/** The catalog entry of a stored `type`, or undefined for a type TotalBase doesn't have. */
export function operationDefinition(type: string): OperationDefinition | undefined {
  return BY_TYPE.get(type);
}

/** The groups of the step menu with their operations, in order - Start left out. */
export function operationMenu(): { group: (typeof OPERATION_GROUPS)[number]; operations: OperationDefinition[] }[] {
  return OPERATION_GROUPS.map((group) => ({ group, operations: OPERATION_CATALOG.filter((definition) => definition.group === group.key) }));
}

/** A terminal step: no output ports, the run (or the loop item) ends there (§3.3). */
export function isTerminalOperation(type: string): boolean {
  return BY_TYPE.get(type)?.outputs.length === 0;
}

/**
 * An operation's output ports (§3.3), given its configuration - a Select case's are its case names, `default`
 * when enabled, then `error`. Undefined for a type TotalBase doesn't have.
 */
export function operationOutputs(type: string, configuration: Record<string, unknown> | undefined): string[] | undefined {
  const definition = BY_TYPE.get(type);
  if (!definition) return undefined;
  if (type !== "totalbase.select-case") return [...definition.outputs];
  const cases = Array.isArray(configuration?.cases) ? (configuration.cases as unknown[]) : [];
  const names = cases.map((c) => (isRecord(c) ? c.output : undefined)).filter((output): output is string => typeof output === "string" && output !== "");
  return [...new Set(names), ...(configuration?.hasDefault === true ? ["default"] : []), ...definition.outputs];
}

/** A configuration value that is set: a non-empty text or list, an object, a number or a boolean. */
function isSet(value: unknown, allowEmpty: boolean): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return allowEmpty || value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** What a step's configuration still lacks to be published (§3.5), one line each in the editor's words. */
export function missingConfiguration(type: string, configuration: Record<string, unknown> | undefined): string[] {
  const values = configuration ?? {};
  return (BY_TYPE.get(type)?.required ?? [])
    .filter((requirement) => {
      if (requirement.when && !requirement.when.is.includes(values[requirement.when.field] as string | undefined)) return false;
      const fields = typeof requirement.field === "string" ? [requirement.field] : requirement.field;
      return !fields.some((field) => isSet(values[field], requirement.allowEmpty === true));
    })
    .map((requirement) => requirement.missing);
}
