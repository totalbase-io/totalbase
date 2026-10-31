import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { commonWidgetProps, defaultWidgetWidth, newWidgetControlConfig, widgetDefinition, WIDGET_NAMES, type WidgetName } from "@totalbase/tb-catalog";
import { UUID_PATTERN } from "@totalbase/shared";
import type { AdminClient } from "./admin-client.js";
import { ADDITIVE, DESTRUCTIVE, filterForStorage, findResource, IDEMPOTENT, READ_ONLY, result, type ResourceRow } from "./tool-helpers.js";

/**
 * Pages (DataViews.md §7-§13): a CUSTOM DataView - or any
 * DataView's record form, a generated page - built from variables
 * (`view_config.variables`), widgets of the widget catalog placed in areas
 * (`POST /admin/api/dataviews/:id/widgets`, `PATCH .../fields/:id`) and Code
 * (`POST .../code`). The server validates every write against the same
 * catalogs the Design form uses; these tools only let an agent name widgets
 * and resources the way it thinks of them - a widget by its Name, a table
 * as "schema.name" - and place a widget with what it holds in one call.
 * totalbase://guide/pages and totalbase://guide/widgets describe the model.
 */

interface PageField {
  id: string;
  kind: "COLUMN" | "RELATED" | "WIDGET";
  widget: string | null;
  label: string | null;
  parent: string | null;
  gridX: number;
  gridY: number;
  gridW: number;
  gridH: number;
  visible: boolean;
  config: { props?: Record<string, unknown>; bindings?: Record<string, unknown>; emits?: Record<string, unknown>; slot?: string } & Record<string, unknown>;
}
interface PageDataView {
  id: string;
  name: string;
  slug: string;
  viewType: string;
  sourceResource: string | null;
  sourceResourceSchema: string | null;
  sourceResourceName: string | null;
  viewConfig: { variables?: Record<string, unknown>[]; record?: { emits?: Record<string, string> } } & Record<string, unknown>;
  code: string;
  liveVersion: number | null;
  hasUnpublishedChanges?: boolean;
}

/** A widget prop bound to a variable (its data, two-way for a Value) or to a formula. */
const bindingInput = z.union([
  z.object({ variable: z.string().describe("A variable's name - a Value for modelValue, a Resource for items / data") }),
  z.object({ formula: z.string().describe("A formula, e.g. {{vars.total.value}} * 1.21 or {{vars.check.status}} == \"pending\"") }),
]);

interface WidgetSpec {
  widget: WidgetName;
  name?: string | undefined;
  slot?: string | undefined;
  props?: Record<string, unknown> | undefined;
  bindings?: Record<string, z.infer<typeof bindingInput>> | undefined;
  emits?: Record<string, string> | undefined;
  width?: number | undefined;
  height?: number | undefined;
  children?: WidgetSpec[] | undefined;
}

const widgetSpec: z.ZodType<WidgetSpec> = z.lazy(() =>
  z.object({
    widget: z.enum(WIDGET_NAMES as [WidgetName, ...WidgetName[]]).describe("A widget of the catalog (totalbase://guide/widgets)"),
    name: z.string().optional().describe("Its Name - how Code (dataview.controls.<name>) and formulas ({{controls.<name>.value}}) reach it, and how these tools refer to it later; unique on the page"),
    slot: z
      .string()
      .optional()
      .describe("The parent's slot it goes in (a Card's header / default / footer, a Tab's content:<tab value>); defaulted when the parent has one. On the page itself: 'header' or 'footer' for the page's header / footer, omitted for its body"),
    props: z.record(z.string(), z.unknown()).optional().describe("Literal props by Nuxt UI name, e.g. {\"label\":\"Save\",\"color\":\"primary\"}; a UFormField's column binds it to the page's record"),
    bindings: z.record(z.string(), bindingInput).optional().describe("Props bound instead of literal: {\"modelValue\":{\"variable\":\"code\"}, \"loading\":{\"formula\":\"{{vars.save.status}} == \\\"pending\\\"\"}}"),
    emits: z.record(z.string(), z.string()).optional().describe("Emit -> the Code function it calls, e.g. {\"click\":\"onSaveClick\"} (save_page_code writes the function)"),
    width: z.number().int().min(0).max(12).optional().describe("Columns of 12 it takes in its row: 6 = two per row, 4 = three; 0 = its content's width, beside what precedes it (a button, a badge, a switch - their default; an input or a container always fills, default 12)"),
    height: z.number().int().min(2).max(30).optional().describe("Sizable widgets only (a table, an editor, a map, an embedded DataView): rows of 40px"),
    children: z.array(widgetSpec).optional().describe("Widgets it holds, each with its slot - a Form's fields, a form field's one input, a Card's content"),
  }),
);

/** How a stored binding reads back. */
const bindingOut = (binding: unknown) => {
  const b = binding as { kind?: string; variable?: string; formula?: string };
  return b.kind === "variable" ? { variable: b.variable } : { formula: b.formula };
};

/** The page's widgets as a tree - areas in order, each widget with what it holds. */
function widgetTree(fields: PageField[]) {
  const widgets = fields.filter((f) => f.kind === "WIDGET");
  const node = (f: PageField): Record<string, unknown> => {
    const config = f.config ?? {};
    const children = widgets.filter((c) => c.parent === f.id).sort((a, b) => a.gridY - b.gridY);
    return {
      id: f.id,
      widget: f.widget,
      ...(f.label && { name: f.label }),
      ...(config.slot && { slot: config.slot }),
      ...(f.gridW !== defaultWidgetWidth(f.widget as WidgetName) && { width: f.gridW }),
      ...(widgetDefinition(f.widget as WidgetName).sizable && { height: f.gridH }),
      ...(Object.keys(config.props ?? {}).length > 0 && { props: config.props }),
      ...(Object.keys(config.bindings ?? {}).length > 0 && { bindings: Object.fromEntries(Object.entries(config.bindings!).map(([k, v]) => [k, bindingOut(v)])) }),
      ...(Object.keys(config.emits ?? {}).length > 0 && { emits: config.emits }),
      ...(children.length > 0 && { children: children.map(node) }),
    };
  };
  return widgets.filter((f) => f.parent === null).sort((a, b) => (a.config.slot ?? "").localeCompare(b.config.slot ?? "") || a.gridY - b.gridY).map(node);
}

/** A widget of the page by its Name or id. */
function findWidget(fields: PageField[], ref: string): PageField {
  const widgets = fields.filter((f) => f.kind === "WIDGET");
  const byId = widgets.find((f) => f.id === ref);
  if (byId) return byId;
  const named = widgets.filter((f) => f.label === ref);
  if (named.length === 1) return named[0]!;
  throw new Error(named.length === 0 ? `No widget named "${ref}" on this page (get_page lists them).` : `${named.length} widgets are named "${ref}" - use its id.`);
}

/** The slot a child goes in when none is named: the parent's only slot, else its `default` one (a Card's content). */
function defaultSlot(parentWidget: WidgetName, slot: string | undefined): string | undefined {
  if (slot) return slot;
  const slots = Object.keys(widgetDefinition(parentWidget).slots);
  if (slots.length === 1) return slots[0];
  if (slots.includes("default")) return "default";
  throw new Error(`${parentWidget} has several slots (${slots.join(", ")}) - name the one a child goes in.`);
}

/** A workflow's slug (or its id) as its id. */
async function workflowId(client: AdminClient, ref: string): Promise<string> {
  if (UUID_PATTERN.test(ref)) return ref;
  const workflows = await client.get<{ id: string; slug: string }[]>("/workflows");
  const found = workflows.find((w) => w.slug === ref);
  if (!found) throw new Error(`No workflow with slug "${ref}" (list_workflows lists them).`);
  return found.id;
}

/** "schema.name" (or an id) as a resource id. */
async function resourceId(client: AdminClient, ref: string, type?: ResourceRow["type"]): Promise<string> {
  if (UUID_PATTERN.test(ref)) return ref;
  const dot = ref.indexOf(".");
  const [schema, name] = dot === -1 ? ["public", ref] : [ref.slice(0, dot), ref.slice(dot + 1)];
  return (await findResource(client, schema, name, type)).id;
}

/** A variable as the agent writes it, with its resources by "schema.name", as `view_config.variables` stores it. */
async function toStoredVariable(client: AdminClient, variable: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (variable["kind"] === "RESOURCE" && typeof variable["resource"] === "string") {
    // Its where and having stored as the grammar takes them - every value text ("true", "7").
    const query = { ...(variable["query"] as Record<string, unknown> | undefined) };
    for (const key of ["where", "having"]) if (query[key] !== undefined) query[key] = filterForStorage(query[key]);
    return { mode: "list", immediate: true, watch: true, count: false, ...variable, query, resource: await resourceId(client, variable["resource"]) };
  }
  if (variable["kind"] === "CALL" && variable["target"] && typeof variable["target"] === "object") {
    const target = variable["target"] as Record<string, unknown>;
    if ((target["type"] === "FUNCTION" || target["type"] === "TABLE") && typeof target["resource"] === "string") {
      return { ...variable, target: { ...target, resource: await resourceId(client, target["resource"], target["type"] as ResourceRow["type"]) } };
    }
    if (target["type"] === "WORKFLOW") {
      // Stored by id - a renamed slug keeps the Call (DataViews.md §8.4); the agent may name it by its slug.
      const ref = typeof target["workflow"] === "string" ? target["workflow"] : typeof target["slug"] === "string" ? target["slug"] : "";
      return { ...variable, target: { type: "WORKFLOW", workflow: await workflowId(client, ref) } };
    }
  }
  return variable;
}

const variableInput = z
  .object({
    name: z.string().describe("^[a-z][a-zA-Z0-9_]*$, at most 32; not vars, controls, slot, record, dataview, params, api, user..."),
    kind: z.enum(["VALUE", "RESOURCE", "CALL"]),
  })
  .passthrough()
  .describe(
    "VALUE {type, default?: {source:'constant',value} | {source:'formula',formula} | {source:'param',name} | {source:'user',field}}; RESOURCE {resource: 'schema.table', query: {fields (required), where, order_by, limit, ...}, mode: list|record, immediate, watch, count}; CALL {target: {type:'FUNCTION', resource:'schema.fn'} | {type:'WORKFLOW', slug} (stored by its id) | {type:'TABLE', resource:'schema.table', action: CREATE|UPDATE|DELETE}, input?: {data: {...}}}; any kind: emits {event: codeFunction}",
  );

export function registerPageTools(server: McpServer, client: AdminClient): void {
  const fieldsOf = (id: string) => client.get<PageField[]>(`/dataviews/${id}/fields`);

  server.registerTool(
    "get_page",
    {
      title: "Get page",
      description:
        "A page's design (a CUSTOM DataView, or any DataView's record form): its record table, variables, widgets as a tree (id, widget, name, slot, width, props, bindings, emits, children - in order), Code, and the record's hooks. Read it before changing a page.",
      inputSchema: { id: z.string().describe("The DataView's id (list_dataviews)") },
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      const [dataview, fields] = await Promise.all([client.get<PageDataView>(`/dataviews/${id}`), fieldsOf(id)]);
      return result({
        id: dataview.id,
        name: dataview.name,
        slug: dataview.slug,
        viewType: dataview.viewType,
        record: dataview.sourceResourceSchema && dataview.sourceResourceName ? `${dataview.sourceResourceSchema}.${dataview.sourceResourceName}` : null,
        variables: dataview.viewConfig.variables ?? [],
        ...(dataview.viewConfig.record?.emits && { recordEmits: dataview.viewConfig.record.emits }),
        widgets: widgetTree(fields),
        code: dataview.code,
        liveVersion: dataview.liveVersion,
        ...(dataview.hasUnpublishedChanges !== undefined && { hasUnpublishedChanges: dataview.hasUnpublishedChanges }),
      });
    },
  );

  server.registerTool(
    "set_page_variables",
    {
      title: "Set page variables",
      description:
        "Define a page's variables (totalbase://guide/pages) - Values (page state), Resources (read-only data through the Data API: a table or view by 'schema.name', a query with fields) and Calls (a function, a MANUAL workflow, or a table write, run as the viewer). Merged by name: each one given replaces the variable of that name or is added; remove drops some. The server checks them (types, query, resources exposed, dependencies) - DATAVIEW_VARIABLES_INVALID says what's wrong. Define variables before the widgets bound to them. The record (`record`) is never defined: a page with a record table has it.",
      inputSchema: {
        id: z.string().describe("The DataView's id"),
        variables: z.array(variableInput).default([]),
        remove: z.array(z.string()).optional().describe("Names of variables to drop"),
      },
      annotations: IDEMPOTENT,
    },
    async ({ id, variables, remove }) => {
      const dataview = await client.get<PageDataView>(`/dataviews/${id}`);
      const given = await Promise.all(variables.map((v) => toStoredVariable(client, v)));
      const byName = new Map(given.map((v) => [v["name"], v]));
      // A replaced variable keeps its place - a formula default sees the variables defined before it; new ones go last.
      const next = (dataview.viewConfig.variables ?? [])
        .filter((v) => !remove?.includes(String(v["name"])))
        .map((v) => byName.get(v["name"]) ?? v);
      for (const variable of given) if (!next.includes(variable)) next.push(variable);
      const updated = await client.patch<PageDataView>(`/dataviews/${id}`, { data: { viewConfig: { variables: next } } });
      return result({ id, variables: updated.viewConfig.variables ?? [] });
    },
  );

  server.registerTool(
    "add_page_widgets",
    {
      title: "Add page widgets",
      description:
        "Place widgets of the widget catalog on a page (totalbase://guide/widgets), each appended after its siblings in its area - with what it holds in one call (children): a UForm with its UFormFields, each holding its one input; a UCard with its header and content. parent (a widget's Name or id) places them inside it; without parent they go on the page (slot 'header' / 'footer' for a CUSTOM page's header and footer). A UFormField whose props.column names a record column edits that column - its input needs no binding. Inputs bind modelValue to a Value variable; option lists and tables bind items / data to a Resource. Answers the page's widget tree. Placed in one transaction: if one is refused, none is placed.",
      inputSchema: {
        id: z.string().describe("The DataView's id"),
        parent: z.string().optional().describe("The widget they go in - its Name or id"),
        widgets: z.array(widgetSpec).min(1),
      },
      annotations: ADDITIVE,
    },
    async ({ id, parent, widgets }) => {
      // Each spec as the server places it - its catalog defaults, its slot, its size - checked here for a prop the
      // widget doesn't have, so the agent hears which; the server checks everything else and places the whole tree
      // in one transaction (POST .../widgets/tree): nothing is left behind when one is refused.
      const placement = (spec: WidgetSpec, parentWidget: WidgetName | null): Record<string, unknown> => {
        const slot = parentWidget ? defaultSlot(parentWidget, spec.slot) : spec.slot;
        const known = { ...widgetDefinition(spec.widget).props, ...commonWidgetProps(spec.widget) };
        const unknown = Object.keys({ ...spec.props, ...spec.bindings }).filter((key) => !(key in known));
        if (unknown.length > 0) throw new Error(`${spec.widget} has no prop ${unknown.map((k) => `"${k}"`).join(", ")} (totalbase://guide/widgets lists its props).`);
        // A newly placed widget as the Design form places it - its catalog label where it has one - except where the label
        // is someone else's: a form field bound to a column (its title follows the column's presentation) and the input
        // inside a form field (the field shows the label; "Switch" or "File upload" beside the input would be noise).
        const { label: catalogLabel, ...withoutLabel } = newWidgetControlConfig(spec.widget).props;
        // Nor a form field or an input placed on its own (M28): "Form field" or "Switch" as its text would be noise.
        const labelIsElsewhere = spec.widget === "UFormField" || widgetDefinition(spec.widget).formField === true || parentWidget === "UFormField";
        const start = labelIsElsewhere ? withoutLabel : { ...withoutLabel, ...(catalogLabel !== undefined && { label: catalogLabel }) };
        const config = {
          props: { ...start, ...spec.props },
          bindings: Object.fromEntries(Object.entries(spec.bindings ?? {}).map(([prop, b]) => [prop, "variable" in b ? { kind: "variable", variable: b.variable } : { kind: "formula", formula: b.formula }])),
          emits: spec.emits ?? {},
          ...(slot && { slot }),
        };
        return {
          widget: spec.widget,
          label: spec.name ?? null,
          config,
          ...(spec.width !== undefined && { gridW: spec.width }),
          ...(spec.height !== undefined && { gridH: spec.height }),
          ...(spec.children?.length && { children: spec.children.map((child) => placement(child, spec.widget)) }),
        };
      };
      const parentField = parent ? findWidget(await fieldsOf(id), parent) : null;
      const parentWidget = parentField ? (parentField.widget as WidgetName) : null;
      await client.post(`/dataviews/${id}/widgets/tree`, {
        data: { widgets: widgets.map((spec) => ({ ...placement(spec, parentWidget), parent: parentField?.id ?? null })) },
      });
      return result({ id, widgets: widgetTree(await fieldsOf(id)) });
    },
  );

  server.registerTool(
    "update_page_widget",
    {
      title: "Update page widget",
      description:
        "Change one placed widget: its Name, props, bindings and emits (merged - a key set to null removes it), its width or height. To move it, move_page_widget.",
      inputSchema: {
        id: z.string().describe("The DataView's id"),
        widget: z.string().describe("The widget's Name or id"),
        name: z.string().nullable().optional(),
        props: z.record(z.string(), z.unknown()).optional(),
        bindings: z.record(z.string(), bindingInput.nullable()).optional(),
        emits: z.record(z.string(), z.string().nullable()).optional(),
        width: z.number().int().min(0).max(12).optional(),
        height: z.number().int().min(2).max(30).optional(),
      },
      annotations: IDEMPOTENT,
    },
    async ({ id, widget, name, props, bindings, emits, width, height }) => {
      const field = findWidget(await fieldsOf(id), widget);
      const merge = <T>(current: Record<string, unknown> | undefined, changes: Record<string, T | null> | undefined, map: (value: T) => unknown = (v) => v) => {
        const out: Record<string, unknown> = { ...current };
        for (const [key, value] of Object.entries(changes ?? {})) {
          if (value === null) delete out[key];
          else out[key] = map(value);
        }
        return out;
      };
      const config = {
        ...field.config,
        props: merge(field.config.props, props),
        bindings: merge(field.config.bindings, bindings, (b) => ("variable" in b ? { kind: "variable", variable: b.variable } : { kind: "formula", formula: b.formula })),
        emits: merge(field.config.emits, emits),
      };
      await client.patch(`/dataviews/${id}/fields/${field.id}`, {
        data: { config, ...(name !== undefined && { label: name }), ...(width !== undefined && { gridW: width }), ...(height !== undefined && { gridH: height }) },
      });
      return result({ id, widgets: widgetTree(await fieldsOf(id)) });
    },
  );

  server.registerTool(
    "move_page_widget",
    {
      title: "Move page widget",
      description:
        "Move a placed widget, with everything its slots hold, to another place on the page - another container or slot, or another position in its own area - keeping its props, bindings, emits and Name. parent: a container's Name or id, or null for the page itself (slot 'header' / 'footer' for its header / footer, omitted for its body); slot defaults to the parent's only one, else its default one; position: 0 = first, omitted = last. The server refuses a place that doesn't take it (a form field's second input, a widget inside itself).",
      inputSchema: {
        id: z.string().describe("The DataView's id"),
        widget: z.string().describe("The widget's Name or id"),
        parent: z.string().nullable().optional().describe("The container's Name or id; null: the page itself; omitted: where it is"),
        slot: z.string().optional().describe("The parent's slot (a Card's header / default / footer, a Tab's content:<tab value>)"),
        position: z.number().int().min(0).optional().describe("Its place in that area: 0 = first; omitted = last"),
      },
      annotations: IDEMPOTENT,
    },
    async ({ id, widget, parent, slot, position }) => {
      const fields = await fieldsOf(id);
      const field = findWidget(fields, widget);
      const parentField = parent === undefined ? (field.parent ? fields.find((f) => f.id === field.parent) ?? null : null) : parent === null ? null : findWidget(fields, parent);
      // The slot named, or the parent's default one; on the page itself only the one named (header / footer / the body).
      const targetSlot = parentField
        ? defaultSlot(parentField.widget as WidgetName, slot ?? (parent === undefined ? field.config.slot : undefined))
        : (slot ?? (parent === undefined ? field.config.slot : undefined));
      // One call: the server changes its place and renumbers its area in one transaction (POST .../widgets/:id/move).
      const after = await client.post<PageField[]>(`/dataviews/${id}/widgets/${field.id}/move`, {
        data: { parent: parentField?.id ?? null, ...(targetSlot !== undefined && { slot: targetSlot }), ...(position !== undefined && { position }) },
      });
      return result({ id, moved: field.id, widgets: widgetTree(after) });
    },
  );

  server.registerTool(
    "delete_page_widget",
    {
      title: "Delete page widget",
      description: "Remove a placed widget from a page's draft, with everything its slots hold. Requires confirm=true.",
      inputSchema: { id: z.string().describe("The DataView's id"), widget: z.string().describe("The widget's Name or id"), confirm: z.literal(true).describe("Must be true") },
      annotations: DESTRUCTIVE,
    },
    async ({ id, widget }) => {
      const field = findWidget(await fieldsOf(id), widget);
      await client.delete(`/dataviews/${id}/fields/${field.id}`);
      return result({ deleted: field.id, widgets: widgetTree(await fieldsOf(id)) });
    },
  );

  server.registerTool(
    "save_page_code",
    {
      title: "Save page code",
      description:
        "Replace a page's Code - plain JavaScript functions (dataview, event) the widgets' and variables' emits call by name, plus onLoad (run once the record and the immediate Resources loaded). record_emits hooks the record's load, before:save (return false to cancel) and save to functions. Code is never run on save: check it with the Preview in the admin, or by publishing and opening the page. totalbase://guide/pages documents dataview.",
      inputSchema: {
        id: z.string().describe("The DataView's id"),
        code: z.string().describe("The whole Code - every function the page's emits name"),
        record_emits: z
          .object({ load: z.string().optional(), "before:save": z.string().optional(), save: z.string().optional() })
          .optional()
          .describe("A page with a record: its events -> Code functions"),
      },
      annotations: IDEMPOTENT,
    },
    async ({ id, code, record_emits }) => {
      await client.post(`/dataviews/${id}/code`, { data: { code } });
      if (record_emits) await client.patch(`/dataviews/${id}`, { data: { viewConfig: { record: { emits: record_emits } } } });
      // Every emit a widget names must be a function the Code declares - a static check, as the Design form's.
      const declared = new Set([...code.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
      const [fields, dataview] = await Promise.all([fieldsOf(id), client.get<PageDataView>(`/dataviews/${id}`)]);
      const missing = [
        ...fields.filter((f) => f.kind === "WIDGET").flatMap((f) => Object.entries(f.config.emits ?? {}).map(([emit, fn]) => ({ widget: f.label ?? f.id, emit, fn: String(fn) }))),
        ...(dataview.viewConfig.variables ?? []).flatMap((v) => Object.entries((v["emits"] as Record<string, string> | undefined) ?? {}).map(([emit, fn]) => ({ variable: String(v["name"]), emit, fn }))),
        ...Object.entries(dataview.viewConfig.record?.emits ?? {}).map(([emit, fn]) => ({ variable: "record", emit, fn })),
      ].filter((e) => !declared.has(e.fn));
      return result({ id, saved: true, functions: [...declared], ...(missing.length > 0 && { warning: "Emits naming functions the Code doesn't declare", missing }) });
    },
  );
}
