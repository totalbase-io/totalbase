import {
  COMMON_INPUT_PROPS,
  COMMON_SIZABLE_PROPS,
  COMMON_STYLE_PROPS,
  COMMON_WIDGET_PROPS,
  PAGE_FOOTER_WIDGETS,
  PAGE_HEADER_WIDGETS,
  VALUE_TYPES,
  VARIABLE_CATALOG,
  WIDGET_COLORS,
  WIDGET_NAMES,
  widgetDefinition,
  widgetState,
  type VariableKindDefinition,
  type WidgetProp,
} from "@totalbase/tb-catalog";

/**
 * The page guides (DataViews.md §7-§13): what a page is built
 * from and how its parts talk, with the variable kinds and every widget
 * generated from the catalogs the server validates a page against - so
 * nothing here can name a prop, slot or emit the server would refuse.
 */

/** How a prop's literal value is written, by its editor. */
const EDITOR_VALUES: Record<string, string> = {
  text: "text",
  textarea: "text",
  number: "a number",
  boolean: "true / false",
  color: WIDGET_COLORS.join(" | "),
  icon: "a Lucide icon, i-lucide-…",
  json: "any JSON",
  attributes: "{ name: value }",
  function: "a Code function's name",
  column: "a column of the page's record",
  junction: "a junction table's resource id: id, a NOT NULL key to the page's record table, one to another table, UNIQUE over both - nothing else",
  dataview: "a published DataView's id",
  detailColumn: "the detail table's foreign key column to the record",
  dashboard: "a published Dashboard's id",
  dashboardVariables: "{ variable: formula }",
  regex: "a JavaScript regular expression",
  tableColumns: "{ field: { label, displayFormat, emptyText, align, bold, color, colorFormula, hidden, ... } }",
  actions: "[{ name, icon, label, formulas: { disabled, visible } }]",
  resourceField: "a field its Resource's query reads",
  items: "[{ value, label, ... }]",
  computedColumns: "[{ key, label, type: text|number|date|timestamp|boolean, formula }]",
};

const BINDINGS: Record<string, string> = {
  value: "bind: {variable: <a Value>} (two-way) - or {formula} on an input: computed, read only",
  resource: "bind: {variable: <a Resource>}",
  formula: "bind: {formula}",
  option: "a field name, or bind: {formula} per option ({{field}} reads the option's row)",
};

/** One page prop as the guides read it - its value, its binding, its default and what it does (a dashboard's presentation widgets too). */
export function pagePropLine(name: string, prop: WidgetProp): string {
  const value = prop.editor === "select" ? (prop.options ?? []).join(" | ") : EDITOR_VALUES[prop.editor] ?? prop.editor;
  const parts = [`- ${name} (${value})`];
  if (prop.binding) parts.push(`[${BINDINGS[prop.binding]}]`);
  if (prop.default !== undefined) parts.push(`default ${JSON.stringify(prop.default)}`);
  if (prop.description) parts.push(`- ${prop.description}`);
  if (prop.itemFields?.length) parts.push(`- each item: value (its key), label, ${prop.itemFields.join(", ")}; formulas {label${prop.itemFields.includes("disabled") ? ", disabled" : ""}${prop.itemFields.includes("visible") ? ", visible" : ""}}`);
  return parts.join(" ");
}

function variableKind(kind: string, definition: VariableKindDefinition): string {
  const props = Object.entries(definition.props).map(([name, p]) => `${name}${p.required ? " (required)" : ""}${p.options ? `: ${p.options.join(" | ")}` : ""}${p.description ? ` - ${p.description}` : ""}`);
  return [
    `### ${kind} - ${definition.label}${definition.creatable ? "" : " (generated, never defined)"}`,
    definition.description,
    ...(props.length > 0 ? [`- Props: ${props.join("; ")}`] : []),
    `- State: ${Object.entries(definition.state).map(([name, s]) => `${name} (${s.description})`).join("; ")}`,
    `- Expose: ${Object.values(definition.expose).map((m) => `${m.signature} - ${m.description}`).join("; ")}`,
    `- Emits: ${Object.entries(definition.emits).map(([name, e]) => `${name}${e.payload ? ` ${e.payload}` : ""}`).join("; ")}`,
  ].join("\n");
}

export function pagesGuide(): string {
  const index = WIDGET_NAMES.map((name) => {
    const w = widgetDefinition(name);
    return `| ${name} | ${w.group} | ${w.description} |`;
  });
  return `# Pages

A page is a screen built from widgets: a **CUSTOM** DataView (create_dataview view_type CUSTOM - a blank page: a point of sale, a search screen, an operation over several tables, a report with parameters) or the record form of any other DataView (a generated page the same tools change). It reads only through the Data API and writes only through a function, a MANUAL workflow or a table write - always as the viewer, under their permissions. Nothing on a page grants data: its roles need the grants for every table, function and workflow its variables use.

Build it in this order: create_dataview CUSTOM (table = its record's table, optional) -> set_page_variables -> add_page_widgets -> save_page_code -> get_page to review -> publish_dataview with its roles. The admin's Design form (Preview) shows it as the App will.

## Three parts
- **Variables** hold data and state; **widgets** show and edit them; **Code** connects them. Widgets never name a table, function or workflow - only variables.
- A widget prop is a literal, or bound: {variable} (a Value for an input's modelValue, two-way; a Resource for a list's items / a table's data) or {formula}.
- An emit (a button's click, an input's change, a Call's success) names a Code function, called (dataview, event).

## Variables (set_page_variables)
Names: ^[a-z][a-zA-Z0-9_]*$, at most 32, unique. Read as {{vars.<name>.<property>}} in formulas ({{vars.x}} alone: a Value's value, a Resource's or Call's data) and dataview.vars.<name> in Code. Value types: ${VALUE_TYPES.join(", ")}.

${(Object.entries(VARIABLE_CATALOG) as [string, VariableKindDefinition][]).map(([kind, definition]) => variableKind(kind, definition)).join("\n\n")}

- A Resource's query is the Data API's (totalbase://guide/data-api) with fields required: {"fields":"id,name","where":{"name":{"_ilike":"{{vars.search.value}}"}},"order_by":"name","limit":50}. {{vars.*}} in where is bound as a value, never pasted in; a related column in fields (site.branch) needs the viewer's grant on that dotted path - a grant's "all" fields are the table's own columns and the paths its foreign keys show rows by, not every column of the related table; an unset value drops its condition (an empty filter shows everything). watch reloads it when a variable its query uses changes.
- A Call's input is the API body: {"data": {...}} with {{vars.*}}; a TABLE CREATE may nest child rows ("$<child_table>": [...]) - one transaction for a row and its children. A TABLE UPDATE / DELETE names its row: {"pk": ..., "data": {...}} or {"where": {...}}. execute(input) in Code replaces the designed input - a form's submit event ({ data }) goes to it as is.
- **record** exists when the page has a record table: the row the page edits - form fields bound to its columns (UFormField column) edit record.data.<column>; record.save() writes it through the Data API (CREATE or UPDATE, permissions, audit, data events). ?pk=<key> in the page's URL opens a row; without it a new one starts.

## Widgets (add_page_widgets; totalbase://guide/widgets has every prop)
- Areas: the page, and each slot of a container (a Form's fields, a Card's header / default / footer, a Tab's content:<tab value>). In an area, widgets flow in order, several to a row: width is columns of 12 (12 by default, 6 = half). Only sizable widgets (tables, editors, maps, embeds) take a height.
- Inputs take no placeholder prop (a hint inside a field vanishes as one types): give the UFormField a help or description; an input bound to a column shows that column's presentation placeholder (set_column_presentation), the one example value an input carries.
- A **form field** (UFormField) holds exactly one input in its default slot. With props.column it edits that column of the record (its label, description, help, required, read-only and a CHECK list's options come from the column - set label, description or help to "" for none, e.g. a Card whose title already names the field); without, its input binds modelValue to a Value.
- A foreign key column's input is a USelectMenu whose items bind to a Resource of the referenced table (valueKey its key, labelKey the field shown). labelKey names a field the Resource reads; a formula over the option's fields goes in bindings: {"labelKey": {"kind": "formula", "formula": "{{tipo}} + \\" \\" + {{numero}}"}} - a literal with {{ is refused. For a long list, props.searchWindow: true adds a 🔍 opening the Resource as a searchable, paged table (searchWindowAs: sidebar (default) | modal) - its columns are the Resource's fields, so give its query.fields what to search and compare by (code, document, city).
- A CUSTOM page's header holds ${PAGE_HEADER_WIDGETS.join(" / ")} (slot 'header' on the page, beside the title); its footer ${PAGE_FOOTER_WIDGETS.join(", ")} (slot 'footer', pinned under the page).
- **Another DataView inside the page** is always TDataView (a published list DataView; its viewers' permissions decide what they read and write). props.column (Linked by) is the intent: set, it shows the rows that belong to the page's record (an order's items, a person's history) - only those, a new row starts linked, nothing until the record is saved; unset, every row. Pick view (one it offers), allow (["create","update","delete"] or fewer - never more than the viewer's permissions; readOnly, a formula, leaves only reading), toolbarMode (none / compact - the default - / full), tools (each toolbar function on or off: { "export": true, "search": false } - search, filter, density, columnsToggle, import, refresh start on; savedViews, history, export, print, autoRefresh off), columns (the column names shown here - their format stays the DataView's), newLabel, paging (off: every row at once), editInline (Linked by only - a record's lines edited in the grid, Tab from cell to cell, and saved with the record's Save in one transaction; a generated MASTER_DETAIL has it on). On a page with a record, wire emits.rowsChanged to a function calling dataview.vars.record.refresh() - a trigger may have recomputed the record; its event is { action: create | update | delete | import, rows }; rowSelected / rowOpened get { row }.
- **Rearranging**: move_page_widget moves a widget (with what it holds, its props, bindings and emits) to another container, slot or position - never delete and re-add it.
- A widget's Name makes it reachable: {{controls.<name>.value}} (an input's value), .item (an option list's chosen row), .row (a Table's clicked row); dataview.controls.<name>.open() / close() / focus() / submit(); a TResult's show({...}) / reset().

| Widget | Group | What it is |
|---|---|---|
${index.join("\n")}

## Formulas
{{vars.x.path}}, {{controls.x.path}}, {{slot.x}} (inside a slot that offers slot props), {{field}} (an option's or a row's field). Operators + - * / % == != > >= < <= && || ! ? : and functions: IF, IFS, AND, OR, NOT, CONCATENATE, UPPER, LOWER, TRIM, LEN, LEFT, RIGHT, MID, SUBSTITUTE, ROUND, ROUNDUP, ROUNDDOWN, ABS, SUM, MIN, MAX, AVERAGE, MOD, POWER, SQRT, ISBLANK, ISNUMBER, ISTEXT, DATE, TODAY, NOW, YEAR, MONTH, DAY, EDATE, DATEDIF, FORMAT_NUMBER(n, 2 | "#,##0.00"), CURRENCY(n, "ARS"), FORMAT_DATE(d, "dd/MM/yyyy") (a bare {{precio}} is the raw number - format it for cards, calendars and pages), BOLD, ITALIC, COLOR, BADGE, LINK, NEW_LINE, ICON. A formula that fails gives no value - never an error on the page. Text is quoted with "...".
Examples: {{vars.save.status}} == "pending" (a button's loading), !ISBLANK({{vars.preview.data}}) (visible), "Total: " + {{vars.total.value}}.

## Code (save_page_code)
Plain JavaScript functions (dataview, event), async allowed. onLoad runs once the record and the immediate Resources loaded; the record's load / before:save (return false to cancel) / save hook through record_emits. A handler that throws shows its message to the viewer.

| dataview. | |
|---|---|
| vars.<name> | the variables (their state and expose above), vars.record included |
| controls.<name> | named widgets: value, item, row, open(), close(), focus(), submit(), validate(), clear(); a TResult's show({ color, icon, title, description, sound, resetAfter }) and reset() |
| params | the page's URL parameters |
| notify(message, color?) | a toast - color success, error, warning, info |
| confirm(question) | the page's dialog, true when confirmed; a text or { title, lines, confirm, color } |
| format.number(v, decimals), .currency(v, code), .date(v), .time(v), .datetime(v) | in the instance's formats |
| openDataView(slug, params?, { newTab }) | another DataView (a record by params { pk }) |
| openFile(result) | a Call's file result ({ asset } or { mimeType, content }) to print or download |

A rejected execute() or a save() resolving to false carries the API's message - the record shows PostgreSQL's reason on its field.

## Patterns

**Find, check, then save a row** (a registration by scanning a document):
- record table: the table of people; form fields bound to its columns (name, birth date, document number...); the photo's form field holds a TCamera (takes it now, crops it - aspect "3:4" - and stores it), the signed form's a UFileUpload, or a TSignature to sign on the screen (uuid foreign keys to files - the column keeps the file's id).
- A Value code (text) and a TScanner bound to it with emits {scan: "onScan"}: it reads with the camera (QR, PDF417 - the DNI -, barcodes; formats "pdf417" narrows it) or a USB reader in keyboard mode (listen "field", or "page" for a kiosk with nothing to click). event is { value, format, source }. The live camera needs HTTPS; without it the widget offers a photo of the code.
- A Call preview (FUNCTION, e.g. 'public.preview_document', a read-only function parsing the code and checking the database) and an UAlert whose title binds a formula over {{vars.preview.data}}, visible when there is one.
- Code:

      async function onScan(dataview, event) {
        const data = await dataview.vars.preview.execute({ data: { code: event.value } })
        if (data.exists) return dataview.notify('Already registered', 'warning')
        for (const [column, value] of Object.entries(data.fields)) dataview.vars.record.set(column, value)
      }
      async function onSaveClick(dataview) {
        if (await dataview.vars.record.save()) { dataview.notify('Saved', 'success'); dataview.vars.record.new() }
      }

- The save is the record's: one Data API write as the viewer - permissions, payload checks, audit, and a DATA_EVENT workflow on the table (a welcome email) fires. Rows that belong to it go with it in one transaction through a TABLE CREATE Call with "$child" rows instead of record.save(). A function's writes don't fire DATA_EVENT workflows; a page can't submit a multi-table /api/transactions request.

**A kiosk** (an entry/exit totem, a phone used as a reader - online only): update_dataview view_config {"kiosk": true} on the CUSTOM page - the App shows it alone, filling the screen, with no menu or page header (a corner "⋮" enters the browser's full screen; an administrator leaves the kiosk view from it), and a notice covers it while the connection or the server is down. Widgets: a TScanner named scanner with listen "page", input false, camera false (a USB reader types anywhere - nothing to click) and emits {scan: "onScan"}; a TResult named result (fillHeight true, idleTitle "Scan your code", resetAfter 4); a Call check (a FUNCTION, e.g. 'public.register_pass', that checks and writes in one transaction and returns { ok, name, message }). Code:

      async function onScan(dataview, event) {
        try {
          const data = await dataview.vars.check.execute({ data: { code: event.value } })
          if (data.ok) dataview.controls.result.show({ color: 'success', icon: 'i-lucide-door-open', title: 'Welcome', description: data.name })
          else dataview.controls.result.show({ color: 'error', title: 'Denied', description: data.message })
        } catch (error) {
          dataview.controls.result.show({ color: 'warning', title: 'Try again', description: error.message })
        }
      }

show({ color (success, error, warning, info, neutral, primary, secondary), icon, title, description, sound ("success" | "error" | false - unset, the color's), resetAfter (seconds, this result) }) - or show('text'), a title alone; the panel goes back to waiting after its Reset after seconds (emits reset - "Back to waiting"), or at once with reset(). A table write instead of a function: a Call TABLE CREATE (one row per pass), its result the row.

**A select that follows another field** (a town of the chosen province): the foreign key's select is fed by a Resource of its table (get_page names it). Give that Resource a where over the record's value and watch on - set_page_variables {name, kind: "RESOURCE", resource, query: {fields, where: {"province": {"_eq": "{{vars.record.data.province}}"}}, limit: 100}, watch: true} - so it reloads when the other field changes; an unset value drops the condition (every row). A select menu holds one page of options: typing searches the whole table on the server, so a limit of 100 never hides a row from it.

**Search screen**: a Value search, a UInput bound to it, a Resource over the table whose where reads {{vars.search.value}} with watch on, a UTable whose data binds to the Resource (its own search and pager drive the Resource), and a row click (emits select) opening the record: dataview.openDataView('customers', { pk: event.row.id }).

**An action over a row**: a Call to a function or a MANUAL workflow with input {"data": {"id": "{{controls.grid.row.id}}"}} and a button whose loading binds {{vars.call.status}} == "pending"; on success refresh the Resource (dataview.vars.items.refresh()).`;
}

export function widgetsGuide(): string {
  const widgets = WIDGET_NAMES.map((name) => {
    const w = widgetDefinition(name);
    const traits = [
      w.group,
      ...(w.accepts ? [`edits ${w.accepts.join(", ")}`] : []),
      ...(w.formField ? ["a form field's input"] : []),
      ...(w.sizable ? ["sizable (height)"] : []),
      ...(w.fillable ? ["fillable"] : []),
    ];
    const lines = [`## ${name} - ${w.label} (${traits.join("; ")})`, w.description];
    const props = Object.entries(w.props).map(([prop, p]) => pagePropLine(prop, p));
    if (props.length > 0) lines.push("Props:", ...props);
    const slots = Object.entries(w.slots).map(
      ([slot, s]) =>
        `- ${slot}${s.perItem ? ":<item value>" : ""} - ${s.label}${s.holds === "input" ? " (one input only)" : ""}${s.canvas === "own" ? " (its own canvas)" : ""}${s.slotProps?.length ? ` - {{slot.${s.slotProps.join("}}, {{slot.")}}}` : ""}`,
    );
    if (slots.length > 0) lines.push("Slots:", ...slots);
    const emits = Object.entries(w.emits).map(([emit, e]) => `${emit}${e.payload ? ` ${e.payload}` : ""}`);
    if (emits.length > 0) lines.push(`Emits: ${emits.join("; ")}`);
    if (w.expose?.length) lines.push(`Expose: ${w.expose.map((m) => `${m}()`).join(", ")}`);
    const state = Object.keys(widgetState(name));
    if (state.length > 0) lines.push(`State: ${state.map((s) => `{{controls.<name>.${s}}}`).join(", ")}`);
    if (w.defaults) lines.push(`Placed with: ${JSON.stringify(w.defaults)}`);
    return lines.join("\n");
  });
  const common = (props: Readonly<Record<string, WidgetProp>>) => Object.entries(props).map(([name, p]) => pagePropLine(name, p)).join("\n");
  return `# Widgets

Every widget a page can hold - the catalog the server validates a page against: a prop, slot or emit not listed here is refused. Props are literals in add_page_widgets' props, or bound in its bindings when marked [bind]. Values in parentheses are what a literal takes.

## Props every widget has
${common(COMMON_WIDGET_PROPS)}

Style (the box around it, the theme's scales):
${common(COMMON_STYLE_PROPS)}

Every input widget below also takes: ${Object.keys(COMMON_INPUT_PROPS).join(", ")} [bind: {formula}] - not repeated in its own list. Sizable widgets also: ${Object.keys(COMMON_SIZABLE_PROPS).join(", ")} (take the height the page has left).

${widgets.join("\n\n")}`;
}
