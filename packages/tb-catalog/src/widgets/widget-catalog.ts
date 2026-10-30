/**
 * The widget catalog (DataViews.md §9, §14.1,
 * 11): every widget a DataView or Dashboard canvas offers, and the one
 * source of truth for it - the Design form's palette, the generic
 * inspector, a column's widget choices (`compatibleWidgets`), the column
 * input catalog (`COLUMN_INPUTS`, column-inputs.ts - each entry points at a
 * widget here) and the server's validation all read it. What isn't here can't be placed.
 *
 * A widget is described the way Nuxt UI documents a component - Props,
 * Slots, Emits - plus Expose, and what TotalBase decides on top: each prop's
 * inspector label and editor, which props bind to a variable, which slot
 * props a slot offers as `{{slot.*}}`, which column values an input edits.
 *
 * Names say where a widget comes from: `U*` is a Nuxt UI component under its
 * own name (some rendered through a small adapter), `T*` is TotalBase's own.
 * apps/admin/app/utils/widget-catalog.check.ts checks every name against the
 * types of the component behind it (`@nuxt/ui`'s, or ours), so an upgrade
 * that renames or drops a prop, slot or emit fails the admin's typecheck.
 *
 * Plain data, no Vue import, so the server reads it too.
 *
 * Deliberately left out: `ui` and `class` (they restyle one instance -
 * AGENTS.md section 25 keeps Nuxt UI's own look), `placeholder` (AGENTS.md
 * section 25: a help text below the field instead), and props a canvas has no
 * use for (`as`, `portal`, `autofocusDelay`…). Slots are only the areas a
 * component lays content out in (a Card's header/body/footer, a Modal's body,
 * an overlay's trigger) - each is a free layout grid, like a container today
 * (DataViews.md §9.3); small slots (`leading`/`trailing`, `item-label`, a table's
 * `<column>-cell`) are covered by props and formulas instead.
 */

/** `nuxt-ui`: a Nuxt UI component (`U*`); `totalbase`: one of TotalBase's own (`T*`). */
export type WidgetSource = "nuxt-ui" | "totalbase";

/**
 * The kinds of value a widget edits - one vocabulary for a column's value
 * (`columnValueKind`, widget-inference.ts) and a Value variable's type
 * (`VALUE_TYPES`, variable-catalog.ts). An input widget lists the kinds it
 * can edit in `accepts`. `relation`, `file` and `range` are column-only (a foreign
 * key, a file, a PostgreSQL range - tstzrange, daterange, numrange...), `date_range`
 * and `time_range` variable-only.
 */
export type ValueKind =
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "time"
  | "timestamp"
  | "json"
  | "point"
  | "array"
  | "relation"
  | "file"
  | "range"
  | "date_range"
  | "time_range";

/**
 * What a widget asks for when it's placed, before it exists: `resource` - the
 * Resource its data comes from (DataViews.md §9.2); `input` - a form field's input
 * widget, and the Value it keeps its value in.
 */
export type WidgetSetup = "resource" | "input";

/** `embed`: another published object shown inside the page - a DataView, a Dashboard. */
export type WidgetGroup = "form" | "input" | "display" | "embed" | "container" | "overlay" | "action";

/** How the inspector edits a prop. */
/** `attributes`: name/value rows (HTML attributes), stored as an object; `function`: a Code function, by name. */
/**
 * `column` - a column of the page's record; `junction` - a junction table of
 * the page's record table, by its resource id; `dataview` - another DataView, by
 * id (the server keeps it as the field's `related_dataview`, a foreign key);
 * `detailColumn` - the column of that DataView's table that points at the
 * page's record; `dataviewView` - one of that DataView's views (its
 * `layouts`); `dataviewColumns` - that DataView's columns shown here (a list of
 * names); `dataviewTools` - its toolbar's functions on or off here
 * (`EMBED_TOOL_DEFAULTS`); `dataviewAllow` - create, update, delete allowed here;
 * `image` - a file's id (one uploaded from the inspector, PUBLIC) or a URL; `dashboard` - a Dashboard, by id (kept as the field's
 * `related_dashboard`); `dashboardVariables` - formulas setting that
 * Dashboard's variables, by name; `fields` - some of the fields of the
 * Resource variable its data is bound to, in order (a Table's Columns);
 * `actions` - icon buttons, each with a name (`TableAction`); `computedColumns`
 * - a Table's columns computed per row (`TableComputedColumn`); `items` - a
 * Tabs', an Accordion's or a Dropdown menu's items (`WidgetItem`), what each
 * holds named by the prop's `itemFields`.
 */
export type PropEditor = "text" | "textarea" | "number" | "boolean" | "select" | "color" | "icon" | "json" | "attributes" | "function" | "column" | "junction" | "dataview" | "detailColumn" | "dataviewView" | "dataviewColumns" | "dataviewTools" | "dataviewAllow" | "image" | "dashboard" | "dashboardVariables" | "regex" | "tableColumns" | "actions" | "resourceField" | "items" | "computedColumns";

/** Widgets whose value is a file's id (a uuid foreign key to files): shown as its image or its name, never the bare id. */
export const FILE_VALUE_WIDGETS: readonly string[] = ["UFileUpload", "TCamera", "TSignature"];

/**
 * An embedded DataView's toolbar functions (TDataView's `tools`) and what each
 * starts as - inside a page saved views, activity, export, print and
 * auto-refresh are mostly noise. Each can only turn off what the DataView has on.
 */
export const EMBED_TOOL_DEFAULTS: Readonly<Record<string, boolean>> = {
  search: true,
  filter: true,
  savedViews: false,
  history: false,
  density: true,
  cardDensity: true,
  columnsToggle: true,
  import: true,
  export: false,
  print: false,
  refresh: true,
  autoRefresh: false,
};
/** What an embedded DataView may let a viewer do besides reading (TDataView's `allow`). */
export const EMBED_ACTIONS = ["create", "update", "delete"] as const;

/**
 * What a prop can be bound to besides its literal value (DataViews.md §9.2):
 * `formula` - a formula over variables/slot props; `value` - a Value variable
 * (a control's `modelValue`, two-way); `resource` - a Resource variable's rows
 * (`items`, `data`); `option` - an option list's field (a Label field) that
 * may instead be a formula evaluated once per option: `{{campo}}` reads that
 * option's row, `{{vars.*}}` the page (`{{balance}} < 0 ? "error" : "success"`).
 */
export type PropBinding = "formula" | "value" | "resource" | "option";

export interface WidgetProp {
  label: string;
  editor: PropEditor;
  /** `select` editor only. */
  options?: readonly string[];
  binding?: PropBinding;
  description?: string;
  /** What an unset prop means, when it isn't Nuxt UI's own default - Visible is on. */
  default?: string | number | boolean;
  /** `items` editor only: what each item has besides its label. */
  itemFields?: readonly WidgetItemField[];
  /** A group of the widget's own props the inspector sets apart under a rule (PROP_SECTIONS) - a Select menu's Search. */
  section?: PropSection;
}

/** The sections a widget's props may be grouped in (`WidgetProp.section`), with their English label. */
export const PROP_SECTIONS = {
  search: "Search",
} as const;
export type PropSection = keyof typeof PROP_SECTIONS;

/**
 * One item of a Tabs, an Accordion or a Dropdown menu (the `items` editor,
 * DataViews.md §9.2): its literals, and formulas
 * over the page (`{{vars.*}}`) for what may follow it - its label, whether
 * it's off, whether it shows at all.
 */
export interface WidgetItem {
  /** Its key - a Tabs' or an Accordion's area is `<slot>:<value>`. Set once, when it's added: renaming the item keeps what its area holds. */
  value?: string;
  label?: string;
  icon?: string;
  /** A Dropdown menu item's color. */
  color?: string;
  /** A Dropdown menu item's Code function, by name - run when it's picked, with `{ item: { value, label } }`. */
  onSelect?: string;
  /** A Splitter panel's share of the whole, in % (`size` field) - the panels' sizes sum to 100. */
  defaultSize?: number;
  /** A Splitter panel's smallest share, in % (`minSize` field). */
  minSize?: number;
  /** A Splitter panel the viewer may drag shut (`collapsible` field). */
  collapsible?: boolean;
  formulas?: { label?: string; disabled?: string; visible?: string };
}
/**
 * What an item has besides its label (and its key): `function` - its `onSelect`; `disabled`, `visible` - their
 * formulas; `size`, `minSize`, `collapsible` - a panel's share of the whole (a Splitter's).
 */
export type WidgetItemField = "icon" | "color" | "function" | "disabled" | "visible" | "size" | "minSize" | "collapsible";
export const WIDGET_ITEM_FORMULAS = ["label", "disabled", "visible"] as const;

/** One of a Table's row actions: an icon button at the end of each row; its `name` tells the Code which was clicked. */
export interface TableAction {
  name: string;
  icon?: string;
  /** Its tooltip - the name when unset. */
  label?: string;
  /** Formulas per row - over its fields (`{{status}}`) and the page: the button off, or not there. */
  formulas?: { disabled?: string; visible?: string };
}

/** What a computed column's formula gives - how its cells format. */
export const COMPUTED_COLUMN_TYPES = ["text", "number", "date", "timestamp", "boolean"] as const;

/**
 * A page Table's computed column (DataViews.md §15):
 * one more column after its Resource's, its value a formula per row -
 * `{{quantity}} * {{unit_price}}`, the page as `{{vars.*}}`. Presentation only:
 * what must filter, sort, add up or stay consistent belongs in PostgreSQL (a
 * generated column, a trigger). Its look is set in Columns, under its `key`.
 */
export interface TableComputedColumn {
  /** Its name in Columns - set once, when it's added. */
  key: string;
  label?: string;
  type: (typeof COMPUTED_COLUMN_TYPES)[number];
  formula: string;
}

export interface WidgetSlot {
  label: string;
  /** Slot props offered to controls inside the slot as `{{slot.<name>}}` (never `ui`). */
  slotProps?: readonly string[];
  /**
   * Where the Design form edits it (DataViews.md §12.4.1): inline on the canvas (the
   * default), or `own` - its own canvas, entered with Open (an overlay's
   * content: not on the page until it opens).
   */
  canvas?: "own";
  /**
   * One area per item (`<slot>:<item key>`) rather than one for all - a Tabs'
   * content per tab, an Accordion's body per section. The key is the item's
   * `value`, else its position.
   */
  perItem?: boolean;
  /** `input`: it holds one input and nothing else - a form field's. */
  holds?: "input";
}

export interface WidgetEmit {
  label: string;
  /** What the Code handler receives as `event`, for its scaffold comment. */
  payload?: string;
}

export interface WidgetDefinition {
  label: string;
  source: WidgetSource;
  /** Lucide icon for the Design form's palette. */
  icon: string;
  group: WidgetGroup;
  description: string;
  /** Input widgets: the column values they can edit - a column's widget choices come from here. */
  accepts?: readonly ValueKind[];
  setup?: WidgetSetup;
  /** Can be the input of a `UFormField` (label, description, help, required) - every input. */
  formField?: boolean;
  /**
   * Has no content to size it (an editor, a map, a table): its height is set
   * on the canvas, in rows (DataViews.md §12.2). Everything else grows with what it holds.
   */
  sizable?: boolean;
  /**
   * A container that grows with what it holds (a Card, a Box) but may take
   * *Fill height* - the height its page has left - and then scroll its own
   * content. No Height of its own: a fixed one would cut what it holds.
   */
  fillable?: boolean;
  /** Props a newly placed widget starts with (a Tabs' two tabs). */
  defaults?: Readonly<Record<string, unknown>>;
  props: Readonly<Record<string, WidgetProp>>;
  slots: Readonly<Record<string, WidgetSlot>>;
  emits: Readonly<Record<string, WidgetEmit>>;
  /** Methods reachable as `dataview.controls.<name>.*` (DataViews.md §9.1). */
  expose?: readonly ("open" | "close" | "focus" | "submit" | "validate" | "clear" | "show" | "reset" | "locate")[];
}

/**
 * A token a Frame's URL may hold (DataViews.md §9.7): a page
 * value - `{{vars.<name>.<path>}}`, `{{controls.<name>.<path>}}`,
 * `{{slot.<prop>.<path>}}` - replaced by that value, URL-encoded. A source,
 * not a RegExp: each user builds its own (`new RegExp(FRAME_URL_TOKEN, "g")`).
 */
export const FRAME_URL_TOKEN = String.raw`\{\{\s*(vars|controls|slot)\.([A-Za-z_]\w*)((?:\.[A-Za-z_]\w*)*)\s*\}\}`;

// --- Shared prop descriptions ------------------------------------------------

/** Nuxt UI's color aliases (app.config.ts `ui.colors`) - every `color` prop. */
export const WIDGET_COLORS = ["primary", "secondary", "success", "info", "warning", "error", "neutral"] as const;
export const WIDGET_SIZES = ["xs", "sm", "md", "lg", "xl"] as const;

const color = { label: "Color", editor: "color", binding: "formula", description: "One of the theme's colors - primary, error, success..." } as const;
const size = { label: "Size", editor: "select", options: WIDGET_SIZES, description: "From xs to xl - Default is md." } as const;
const icon = { label: "Icon", editor: "icon", binding: "formula", description: "An icon at its start." } as const;
const trailingIcon = { label: "Trailing icon", editor: "icon", binding: "formula", description: "An icon at its end." } as const;
const disabled = { label: "Disabled", editor: "boolean", binding: "formula", description: "Shown greyed out - it can't be used." } as const;
const required = { label: "Required", editor: "boolean", binding: "formula", description: "Needs a value before the form submits - a NOT NULL column already does." } as const;
const loading = { label: "Loading", editor: "boolean", binding: "formula", description: "Shows a spinner while something is busy." } as const;
const highlight = { label: "Highlight", editor: "boolean", binding: "formula", description: "Outlined in its color, to draw attention." } as const;
const orientation = { label: "Orientation", editor: "select", options: ["horizontal", "vertical"], description: "Laid out in a row or in a column." } as const;
/** TotalBase's own - a Modal or a Slideover has no size in Nuxt UI: its width, the record form's scale (EditFormShell.vue). */
const overlaySize = { label: "Size", editor: "select", options: ["sm", "md", "lg", "xl"], description: "Its width, from sm to xl - unset, Nuxt UI's own." } as const;
const text = (label: string) => ({ label, editor: "text", binding: "formula" }) as const;
const variant = (options: readonly string[]) => ({ label: "Variant", editor: "select", options, binding: "formula", description: "Its style: filled, outlined, soft..." }) as const;

const INPUT_VARIANTS = ["outline", "soft", "subtle", "ghost", "none"] as const;
const SOLID_VARIANTS = ["solid", "outline", "soft", "subtle"] as const;

/** A value control's `modelValue` - two-way with a Value variable, or a formula: a computed input, read only (DataViews.md §9.2). */
const modelValue = {
  label: "Value",
  editor: "text",
  binding: "value",
  description: "A Value variable it reads and writes - or a formula (the link): shown read only, written nowhere, e.g. {{controls.selectCustomer.item.tax_id}}.",
} as const;
/** An option list's `items` - a Resource variable's rows, read through `valueKey`/`labelKey`/`descriptionKey`. */
const items = { label: "Options", editor: "json", binding: "resource" } as const;
const valueKey = {
  label: "Value field",
  editor: "resourceField",
  description: "The field of each option that is stored - its primary key by default.",
} as const;
const labelKey = {
  label: "Label field",
  editor: "resourceField",
  binding: "option",
  description: 'The field shown for each option - or a formula over its fields, e.g. {{sku}} + " - " + {{name}}; its Resource must read them.',
} as const;
const descriptionKey = {
  label: "Description field",
  editor: "resourceField",
  binding: "option",
  description: "Shown muted beneath the label - a field, or a formula over its fields.",
} as const;
// TotalBase's own, like the Label field's formula: its renderer fills each option's icon and `disabled` from its row - Nuxt UI never sees them.
const iconKey = {
  label: "Icon field",
  editor: "resourceField",
  binding: "option",
  description: "Each option's icon, e.g. i-lucide-banknote - a field, or a formula over its fields.",
} as const;
const disabledKey = {
  label: "Disabled field",
  editor: "resourceField",
  binding: "option",
  description: "Turns an option off - a true/false field, or a formula over its fields and the page: {{id}} == 5 && !{{vars.customer.data.active}}.",
} as const;

const valueEmits = {
  "update:modelValue": { label: "Value changed", payload: "{ value }" },
  change: { label: "Change", payload: "{ value }" },
  blur: { label: "Blur", payload: "{ value }" },
} as const;
const focusEmits = { ...valueEmits, focus: { label: "Focus", payload: "{ value }" } } as const;
const optionEmits = {
  ...focusEmits,
  "update:modelValue": { label: "Value changed", payload: "{ value, item } - `item` is the chosen option's whole row" },
} as const;
const overlayEmits = {
  "update:open": { label: "Opened / closed", payload: "{ open }" },
  "after:leave": { label: "Closed (after its animation)" },
} as const;

/**
 * The codes a Scanner reads (DataViews.md §9.9), by the
 * BarcodeDetector API's names - a camera reads them with the browser's own
 * detector where it knows them, else with zxing-wasm; a USB reader in
 * keyboard mode types whatever it reads. `pdf417` is the Argentine DNI's.
 */
export const SCANNER_FORMATS = ["qr_code", "pdf417", "code_128", "code_39", "code_93", "ean_13", "ean_8", "upc_a", "upc_e", "itf", "codabar", "data_matrix", "aztec"] as const;
export type ScannerFormat = (typeof SCANNER_FORMATS)[number];

/** How a Camera crops what it took: the photo as framed, or to a fixed shape. */
export const CAMERA_ASPECTS = ["original", "1:1", "3:4", "4:3"] as const;

// --- The catalog ---------------------------------------------------------------

export const WIDGET_CATALOG = {
  // Form
  UForm: {
    label: "Form",
    source: "nuxt-ui",
    icon: "i-lucide-clipboard-list",
    group: "form",
    description: "Groups fields: checks the required ones and emits submit with { data } - the fields' values by name.",
    props: {
      disabled,
      loadingAuto: { label: "Busy while submitting", editor: "boolean", default: true, description: "Its submit button shows loading while the submit handler runs." },
      validate: {
        label: "Validate",
        editor: "function",
        description: "A Code function (dataview, { data }) returning { errors: [{ field, message }] } - may be async.",
      },
    },
    slots: { default: { label: "Fields" } },
    emits: {
      submit: { label: "Submit", payload: "{ data } - the fields' values by name, the body a Call takes as is" },
      error: { label: "Errors", payload: "{ errors: [{ field, message }] }" },
    },
    expose: ["submit", "validate", "clear"],
  },
  UFormField: {
    label: "Form field",
    source: "nuxt-ui",
    icon: "i-lucide-text-cursor",
    group: "form",
    description: "A labelled field around one input: label, help, required.",
    setup: "input",
    props: {
      column: {
        label: "Column",
        editor: "column",
        description:
          "A column of the page's record: its input edits record.data.<column>. PostgreSQL's NOT NULL makes it required, and it's read-only where the viewer may not write it.",
      },
      junction: {
        label: "Junction table",
        editor: "junction",
        description:
          "Instead of a column: a junction table between the page's record and another table. Its input picks several of the other table's rows, and the record's Save adds and removes the junction's rows, as the viewer, in the same transaction.",
      },
      label: text("Label"),
      block: { label: "Full width", editor: "boolean", default: true, description: "Its input fills the field - set the field's width and the input follows." },
      description: text("Description"),
      hint: text("Hint"),
      help: text("Help"),
      required,
      pattern: {
        label: "Pattern",
        editor: "regex",
        description:
          "A regular expression (JavaScript) the whole value must match - checked as the viewer types, with the column's own CHECK. PostgreSQL still decides on save; an empty value is left to Required.",
      },
      patternMessage: { ...text("Pattern message"), description: "Shown under the field when the value doesn't match. Empty: Invalid format." },
      error: text("Error"),
      name: {
        label: "Name",
        editor: "text",
        description: "Its value's key in the form's data - by convention the column it saves to. Empty: its column, else the input's variable.",
      },
      size,
      orientation,
      labelWidth: {
        label: "Label width",
        editor: "select",
        options: ["1/4", "1/3", "2/5", "1/2"],
        description: "Horizontal: the label takes this share of the field and the input the rest - set the same on fields beside each other and their values line up. A phone stacks it, label above.",
      },
    },
    slots: { default: { label: "Input", holds: "input" } },
    emits: {},
  },

  // Embed - another published object inside the page; its access stays its own.
  TDataView: {
    label: "DataView",
    source: "totalbase",
    icon: "i-lucide-panels-top-left",
    group: "embed",
    description: "Another DataView inside the page - its grid, cards, map, board, calendar or timeline, its New and its record form. Linked by a column: the rows that belong to the page's record (an order's items, a person's history); without: every row its own filter allows.",
    sizable: true,
    props: {
      dataview: {
        label: "DataView",
        editor: "dataview",
        description: "A published DataView. Its viewers' permissions decide what they read and write in it.",
      },
      column: {
        label: "Linked by",
        editor: "detailColumn",
        description: "The rows that belong to the page's record: only those whose column points at it, a new row starts linked to it, and nothing shows until the record is saved. Empty: every row.",
      },
      view: { label: "View", editor: "dataviewView", description: "Which of the DataView's views it shows - empty: the one it opens with." },
      allow: {
        label: "Allow",
        editor: "dataviewAllow",
        description: "What it lets a viewer do besides reading - only less than their permissions and than the DataView it shows allows, never more. Empty: all three.",
      },
      toolbarMode: {
        label: "Toolbar",
        editor: "select",
        options: ["none", "compact", "full"],
        default: "compact",
        description: "none: only New; compact: search and a menu; full: every action a button. A phone is always compact.",
      },
      tools: {
        label: "Toolbar functions",
        editor: "dataviewTools",
        description: "Each of its toolbar's functions, on or off here - only off what the DataView has on.",
      },
      columns: { label: "Columns", editor: "dataviewColumns", description: "Each of its columns shown or hidden here - their format is the DataView's. Empty: as the DataView shows them." },
      newLabel: text("New button"),
      paging: { label: "Pages", editor: "boolean", default: true, description: "Off: every row at once - a record's items." },
      editInline: {
        label: "Edit in the grid",
        editor: "boolean",
        default: false,
        description: "Linked by a column: its rows edited in place - Tab from cell to cell, Tab past the last adds one - and saved with the page's record, in one transaction. Off: each row in its own form.",
      },
      readOnly: { label: "Read only", editor: "boolean", binding: "formula", description: "Nothing but reading here, whatever Allow says - an issued invoice's items: {{vars.record.data.status}} == \"ISSUED\"." },
    },
    slots: {},
    emits: {
      rowsChanged: { label: "Rows changed", payload: "{ action, rows } - create, update, delete or import, and the rows saved or deleted" },
      rowSelected: { label: "Row selected", payload: "{ row } - the row clicked" },
      rowOpened: { label: "Row opened", payload: "{ row } - its record form opened" },
    },
  },
  TDashboard: {
    label: "Dashboard",
    source: "totalbase",
    icon: "i-lucide-layout-dashboard",
    group: "embed",
    description: "A published Dashboard, its variables set from the page - a customer's own figures, for one.",
    sizable: true,
    props: {
      dashboard: {
        label: "Dashboard",
        editor: "dashboard",
        description: "A published Dashboard. Who sees it is its own: a viewer without access sees it isn't available.",
      },
      variables: {
        label: "Variables",
        editor: "dashboardVariables",
        description: "A formula per variable, e.g. {{vars.record.data.id}} - set ones are hidden from its bar; the rest stay the viewer's to pick.",
      },
    },
    slots: {},
    emits: {},
  },
  TFrame: {
    label: "Frame",
    source: "totalbase",
    icon: "i-lucide-app-window",
    group: "embed",
    description: "Another site's page in a sandboxed frame - its URL may take values from the page, e.g. the record's tracking number.",
    sizable: true,
    props: {
      url: {
        label: "URL",
        editor: "text",
        description:
          "https://… - a value goes where a token is: https://tracking.example/shipments/{{vars.record.data.tracking_id}}. The site itself is fixed (tokens only after the / that follows it), each value is URL-encoded, and the values are sent to that site.",
      },
      title: { ...text("Title"), description: "What the frame shows, for screen readers." },
      openInNewTab: { label: "Open in new tab", editor: "boolean", description: "A button above it that opens the same page in a new tab." },
    },
    slots: {},
    emits: {},
  },

  // Inputs
  UInput: {
    label: "Input",
    source: "nuxt-ui",
    icon: "i-lucide-text-cursor-input",
    group: "input",
    description: "A single-line text field.",
    accepts: ["text", "number", "date", "time", "timestamp"],
    formField: true,
    props: {
      modelValue,
      type: {
        label: "Type",
        editor: "select",
        options: ["text", "email", "password", "tel", "url", "search", "number", "date", "time", "datetime-local", "month", "week", "color"],
        description: "The browser's own input for it - datetime-local shows a timestamp with time zone in the viewer's.",
      },
      color,
      variant: variant(INPUT_VARIANTS),
      size,
      icon,
      trailingIcon,
      disabled,
      highlight,
    },
    slots: {},
    emits: valueEmits,
    expose: ["focus"],
  },
  UTextarea: {
    label: "Textarea",
    source: "nuxt-ui",
    icon: "i-lucide-text",
    group: "input",
    description: "Multi-line text.",
    sizable: true,
    accepts: ["text", "json"],
    formField: true,
    props: {
      modelValue,
      rows: { label: "Rows", editor: "number" },
      autoresize: { label: "Grow with its text", editor: "boolean", description: "Gets taller as the text grows, instead of scrolling." },
      maxrows: { label: "Max rows", editor: "number" },
      color,
      variant: variant(INPUT_VARIANTS),
      size,
      icon,
      disabled,
      highlight,
    },
    slots: {},
    emits: valueEmits,
    expose: ["focus"],
  },
  UInputNumber: {
    label: "Number",
    source: "nuxt-ui",
    icon: "i-lucide-hash",
    group: "input",
    description: "A number, with increment and decrement buttons.",
    accepts: ["number"],
    formField: true,
    props: {
      modelValue,
      min: { label: "Min", editor: "number", binding: "formula" },
      max: { label: "Max", editor: "number", binding: "formula" },
      step: { label: "Step", editor: "number" },
      orientation,
      color,
      variant: variant(INPUT_VARIANTS),
      size,
      disabled,
      highlight,
    },
    slots: {},
    emits: valueEmits,
    expose: ["focus"],
  },
  UInputDate: {
    label: "Date",
    source: "nuxt-ui",
    icon: "i-lucide-calendar",
    group: "input",
    description: "A date, a date and time, or a date range.",
    accepts: ["date", "timestamp", "date_range"],
    formField: true,
    props: {
      modelValue,
      range: { label: "Date range", editor: "boolean", description: "Picks a start and an end date." },
      granularity: {
        label: "Precision",
        editor: "select",
        options: ["day", "hour", "minute", "second"],
        description: "A timestamp's: to the minute when unset. A date column is always to the day.",
      },
      calendar: { label: "Calendar", editor: "boolean", default: true, description: "A calendar button beside the field - its days stop at the column's CHECK bounds; a timestamp's time below it. Typing stays." },
      color,
      variant: variant(INPUT_VARIANTS),
      size,
      icon,
      disabled,
      highlight,
    },
    slots: {},
    emits: focusEmits,
    expose: ["focus"],
  },
  UInputTime: {
    label: "Time",
    source: "nuxt-ui",
    icon: "i-lucide-clock",
    group: "input",
    description: "A time of day, or a time range.",
    accepts: ["time", "time_range"],
    formField: true,
    props: {
      modelValue,
      range: { label: "Time range", editor: "boolean", description: "Picks a start and an end time." },
      picker: { label: "Picker", editor: "boolean", default: true, description: "A clock button beside the field - an hour column and a minute column to pick from. Typing stays." },
      minuteStep: { label: "Minute step", editor: "select", options: ["1", "5", "10", "15", "30"], default: "5", description: "The minutes the picker offers - every 5 by default. A minute typed in between is kept." },
      color,
      variant: variant(INPUT_VARIANTS),
      size,
      icon,
      disabled,
      highlight,
    },
    slots: {},
    emits: focusEmits,
    expose: ["focus"],
  },
  USwitch: {
    label: "Switch",
    source: "nuxt-ui",
    icon: "i-lucide-toggle-right",
    group: "input",
    description: "An on/off value.",
    accepts: ["boolean"],
    formField: true,
    props: {
      modelValue,
      label: text("Label"),
      description: text("Description"),
      color,
      size,
      loading,
      disabled,
    },
    slots: {},
    emits: { change: { label: "Change", payload: "{ value }" } },
  },
  UCheckbox: {
    label: "Checkbox",
    source: "nuxt-ui",
    icon: "i-lucide-square-check",
    group: "input",
    description: "A yes/no value.",
    accepts: ["boolean"],
    formField: true,
    props: {
      modelValue,
      label: text("Label"),
      description: text("Description"),
      color,
      variant: variant(["list", "card"]),
      size,
      disabled,
    },
    slots: {},
    emits: { change: { label: "Change", payload: "{ value }" } },
  },
  USelect: {
    label: "Select",
    source: "nuxt-ui",
    icon: "i-lucide-chevrons-up-down",
    group: "input",
    description: "Pick from a short list - no search.",
    accepts: ["text", "relation"],
    setup: "resource",
    formField: true,
    props: {
      modelValue,
      items,
      valueKey,
      labelKey,
      descriptionKey,
      iconKey,
      disabledKey,
      multiple: { label: "Multiple", editor: "boolean", description: "Picks several options - its value is a list." },
      color,
      variant: variant(INPUT_VARIANTS),
      size,
      icon,
      disabled,
      highlight,
    },
    slots: {},
    emits: optionEmits,
    expose: ["focus"],
  },
  USelectMenu: {
    label: "Select menu",
    source: "nuxt-ui",
    icon: "i-lucide-list-filter",
    group: "input",
    description: "Pick from a list, with search.",
    accepts: ["text", "relation"],
    setup: "resource",
    formField: true,
    props: {
      modelValue,
      items,
      valueKey,
      labelKey,
      descriptionKey,
      iconKey,
      disabledKey,
      multiple: { label: "Multiple", editor: "boolean", description: "Picks several options - its value is a list." },
      clear: { label: "Clear button", editor: "boolean", description: "An ✕ that empties the value." },
      // The Search section: what typing in it may do, and TotalBase's own search window - a 🔍 beside it opening its
      // Resource as a searchable, paged table, a long list's search.
      createItem: {
        label: "Create from search",
        editor: "boolean",
        section: "search",
        description: "Options from a Resource: typing a value it doesn't list offers Create - a new row of its table with that value in its Label field, saved as the viewer (their CREATE permission), then picked. PostgreSQL decides whether the row is valid.",
      },
      searchWindow: {
        label: "Search window",
        editor: "boolean",
        section: "search",
        description: "Options from a Resource: a 🔍 beside it opens them as a table - its Resource's fields as columns, searched and paged on the server - to pick one by any of them. For long lists.",
      },
      searchWindowAs: {
        label: "Search window as",
        editor: "select",
        options: ["sidebar", "modal"],
        section: "search",
        description: "Where the search window opens - a sidebar (the default, room for a long list) or a modal. Full screen on a phone.",
      },
      searchWindowSize: {
        label: "Search window size",
        editor: "select",
        options: ["sm", "md", "lg", "xl"],
        section: "search",
        description: "Its width - unset, Nuxt UI's own (a narrow sidebar or modal); sm to xl as a record form's sizes, xl for a wide table. Full screen on a phone from md.",
      },
      color,
      variant: variant(INPUT_VARIANTS),
      size,
      icon,
      disabled,
      highlight,
    },
    slots: {},
    emits: { ...optionEmits, clear: { label: "Cleared" }, create: { label: "Row created", payload: "{ item } - the row created from the search" } },
    expose: ["focus"],
  },
  UInputMenu: {
    label: "Autocomplete",
    source: "nuxt-ui",
    icon: "i-lucide-search",
    group: "input",
    description: "Type to find an option.",
    accepts: ["text"],
    setup: "resource",
    formField: true,
    props: {
      modelValue,
      items,
      valueKey,
      labelKey,
      descriptionKey,
      iconKey,
      disabledKey,
      multiple: { label: "Multiple", editor: "boolean", description: "Picks several options - its value is a list." },
      clear: { label: "Clear button", editor: "boolean", description: "An ✕ that empties the value." },
      color,
      variant: variant(INPUT_VARIANTS),
      size,
      icon,
      disabled,
      highlight,
    },
    slots: {},
    emits: { ...optionEmits, clear: { label: "Cleared" } },
    expose: ["focus"],
  },
  URadioGroup: {
    label: "Radio group",
    source: "nuxt-ui",
    icon: "i-lucide-circle-dot",
    group: "input",
    description: "Pick one of a few options, all visible.",
    accepts: ["text"],
    setup: "resource",
    formField: true,
    props: {
      modelValue,
      items,
      valueKey,
      labelKey,
      descriptionKey,
      iconKey: { ...iconKey, description: `${iconKey.description} Shown above its label when Indicator is hidden.` },
      // TotalBase's own as well: each option's icon color, from its row.
      colorKey: {
        label: "Color field",
        editor: "resourceField",
        binding: "option",
        description: "Each option's icon color, one of the theme's (primary, success, warning...) - a field, or a formula: {{balance}} < 0 ? \"error\" : \"success\".",
      },
      disabledKey,
      // TotalBase's own as well: its options' icons, larger than Nuxt UI draws them beside a label.
      iconSize: { label: "Icon size", editor: "select", options: ["sm", "md", "lg", "xl", "2xl"], description: "Each option's icon - from sm to 2xl; empty keeps Nuxt UI's." },
      legend: text("Legend"),
      orientation,
      color,
      variant: variant(["list", "card", "table"]),
      indicator: { label: "Indicator", editor: "select", options: ["start", "end", "hidden"], description: "Where its dot sits - hidden shows each option's icon instead, as cards do." },
      // TotalBase's own: Nuxt UI lays them out in one row or one column.
      columns: { label: "Columns", editor: "select", options: ["1", "2", "3", "4", "5", "6"], description: "Options per row - the rest wrap below. Two per row on a phone." },
      size,
      disabled,
    },
    slots: {},
    emits: { change: { label: "Change", payload: "{ value, item }" } },
  },

  UInputTags: {
    label: "Tags",
    source: "nuxt-ui",
    icon: "i-lucide-tags",
    group: "input",
    description: "A free-form list of short text values.",
    accepts: ["array"],
    formField: true,
    props: {
      modelValue,
      maxLength: { label: "Max length", editor: "number" },
      color,
      variant: variant(INPUT_VARIANTS),
      size,
      icon,
      disabled,
      highlight,
    },
    slots: {},
    emits: focusEmits,
    expose: ["focus"],
  },
  UCheckboxGroup: {
    label: "Checkbox group",
    source: "nuxt-ui",
    icon: "i-lucide-list-todo",
    group: "input",
    description: "Pick any number of options, all visible.",
    accepts: ["array"],
    setup: "resource",
    formField: true,
    props: {
      modelValue,
      items,
      valueKey,
      labelKey,
      descriptionKey,
      disabledKey,
      legend: text("Legend"),
      orientation,
      color,
      variant: variant(["list", "card", "table"]),
      size,
      disabled,
    },
    slots: {},
    emits: { "update:modelValue": { label: "Value changed", payload: "{ value }" }, change: { label: "Change", payload: "{ value }" } },
  },
  UListbox: {
    label: "Listbox",
    source: "nuxt-ui",
    icon: "i-lucide-list-checks",
    group: "input",
    description: "A visible, filterable list to pick from.",
    accepts: ["text"],
    setup: "resource",
    formField: true,
    props: {
      modelValue,
      items,
      valueKey,
      labelKey,
      descriptionKey,
      iconKey,
      disabledKey,
      multiple: { label: "Multiple", editor: "boolean", description: "Picks several options - its value is a list." },
      filter: { label: "Filter box", editor: "boolean", description: "A search box above the options." },
      color,
      size,
      loading,
      disabled,
      highlight,
    },
    slots: {},
    emits: {
      "update:modelValue": { label: "Value changed", payload: "{ value, item }" },
      change: { label: "Change", payload: "{ value }" },
    },
  },
  UPinInput: {
    label: "PIN input",
    source: "nuxt-ui",
    icon: "i-lucide-key-round",
    group: "input",
    description: "A short code with a fixed number of characters.",
    accepts: ["text"],
    formField: true,
    props: {
      modelValue,
      length: { label: "Length", editor: "number" },
      type: { label: "Type", editor: "select", options: ["text", "number"] },
      mask: { label: "Mask", editor: "boolean", description: "Hides what is typed, like a password." },
      color,
      variant: variant(INPUT_VARIANTS),
      size,
      disabled,
      highlight,
    },
    slots: {},
    emits: { ...valueEmits, complete: { label: "Completed", payload: "{ value }" } },
  },
  USlider: {
    label: "Slider",
    source: "nuxt-ui",
    icon: "i-lucide-sliders-horizontal",
    group: "input",
    description: "A number picked along a bounded range.",
    accepts: ["number"],
    formField: true,
    props: {
      modelValue,
      min: { label: "Min", editor: "number", binding: "formula" },
      max: { label: "Max", editor: "number", binding: "formula" },
      step: { label: "Step", editor: "number" },
      tooltip: { label: "Tooltip", editor: "boolean", description: "Shows the value above the handle while dragging." },
      orientation,
      color,
      size,
      disabled,
    },
    slots: {},
    emits: { "update:modelValue": { label: "Value changed", payload: "{ value }" }, change: { label: "Change", payload: "{ value }" } },
  },
  UInputRating: {
    label: "Rating",
    source: "nuxt-ui",
    icon: "i-lucide-star",
    group: "input",
    description: "A star rating out of a fixed maximum.",
    accepts: ["number"],
    formField: true,
    props: {
      modelValue,
      length: { label: "Stars", editor: "number" },
      readonly: { label: "Read only", editor: "boolean", binding: "formula" },
      icon,
      color,
      size,
      disabled,
    },
    slots: {},
    emits: { "update:modelValue": { label: "Value changed", payload: "{ value }" }, change: { label: "Change", payload: "{ value }" } },
  },
  UFileUpload: {
    label: "File upload",
    source: "nuxt-ui",
    icon: "i-lucide-file-up",
    group: "input",
    description: "A single uploaded file or image.",
    accepts: ["file"],
    formField: true,
    props: {
      modelValue,
      label: { ...text("Label"), description: "The empty field's text - the area's, or the button variant's. Unset: Drop a file here or click to browse." },
      description: { ...text("Description"), description: "A line under the area's text." },
      buttonLabel: { ...text("Button"), description: "The area variant: a button under its text (Upload file), for whoever doesn't know the area can be tapped." },
      accept: { label: "Accepted types", editor: "text", description: "File types to accept, e.g. image/*,.pdf" },
      preview: {
        label: "Show the image",
        editor: "boolean",
        description: "An image shows itself across the field instead of its name - tapping it picks another. Read only, it is only the image.",
      },
      aspect: { label: "Image shape", editor: "select", options: CAMERA_ASPECTS, description: "With Show the image: original keeps the image's own shape; a ratio frames it (3:4 portrait - a carnet photo)." },
      height: {
        label: "Height",
        editor: "number",
        description: "In pixels, whatever the screen: the empty area's - to line it up with the cards beside it - and, with Show the image, the image's (with a shape its width follows, centered; without, it spans the field; it covers the frame).",
      },
      icon,
      color,
      variant: variant(["area", "button"]),
      size,
      disabled,
    },
    slots: {},
    emits: { "update:modelValue": { label: "File changed", payload: "{ value }" } },
    expose: ["open"],
  },
  TScanner: {
    label: "Scanner",
    source: "totalbase",
    icon: "i-lucide-scan-barcode",
    group: "input",
    description: "Reads a QR code, a PDF417 (a DNI) or a barcode - with the device's camera or a USB reader in keyboard mode - and emits what it read.",
    accepts: ["text"],
    formField: true,
    props: {
      modelValue: { ...modelValue, description: "A Value variable that keeps the last code read (or a record column it fills)." },
      input: { label: "Text field", editor: "boolean", default: true, description: "A field where a USB reader types (or a person does) - Enter reads it." },
      camera: { label: "Camera", editor: "boolean", default: true, description: "A button that opens the camera to read a code. The browser allows it only over HTTPS (or on localhost)." },
      listen: {
        label: "USB reader",
        editor: "select",
        options: ["field", "page"],
        description: "field: what's typed in its text field; page: a reader's burst of keys anywhere on the page, with nothing focused - for a kiosk.",
      },
      formats: {
        label: "Formats",
        editor: "text",
        description: `The codes the camera reads, comma-separated - empty: all of them. ${SCANNER_FORMATS.join(", ")}.`,
      },
      continuous: { label: "Keep reading", editor: "boolean", description: "The camera stays open after a read, for the next one (the same code again only after a pause)." },
      beep: { label: "Beep", editor: "boolean", default: true, description: "A short tone on each read." },
      vibrate: { label: "Vibrate", editor: "boolean", default: true, description: "A short vibration on each read, where the device can." },
      label: { ...text("Camera button"), description: "The camera button's text - empty: an icon only." },
      icon: { ...icon, description: "The camera button's icon - unset: a barcode." },
      color,
      variant: variant(["solid", "outline", "soft", "subtle", "ghost", "link"]),
      size,
      disabled,
    },
    slots: {},
    emits: {
      scan: { label: "Scanned", payload: "{ value, format, source } - the text read, its format (qr_code, pdf417, ... - null from a USB reader) and camera | keyboard" },
      "update:modelValue": { label: "Value changed", payload: "{ value }" },
      error: { label: "Error", payload: "{ message } - the camera couldn't open (no permission, no HTTPS, no camera)" },
    },
    expose: ["open", "close", "focus"],
  },
  TCamera: {
    label: "Camera",
    source: "totalbase",
    icon: "i-lucide-camera",
    group: "input",
    description: "Takes a photo with the device's camera, crops and compresses it, and stores it as a file - for a file column, like a person's photo.",
    accepts: ["file"],
    formField: true,
    props: {
      modelValue,
      label: { ...text("Button"), description: "The button's text - empty: Take photo." },
      facing: { label: "Camera", editor: "select", options: ["environment", "user"], description: "environment: the back camera; user: the front one (a selfie). The viewer can switch." },
      aspect: { label: "Crop", editor: "select", options: CAMERA_ASPECTS, description: "original keeps the photo as framed; a ratio crops it to that shape (1:1 square, 3:4 portrait - a carnet photo)." },
      maxSize: { label: "Largest side", editor: "number", description: "In pixels - a larger photo is scaled down to it (default 1600)." },
      quality: { label: "Quality", editor: "number", description: "JPEG quality from 0.1 to 1 (default 0.85) - lower, a smaller file." },
      icon: { ...icon, description: "The button's icon - unset: a camera." },
      color,
      variant: variant(["solid", "outline", "soft", "subtle", "ghost", "link"]),
      size,
      disabled,
    },
    slots: {},
    emits: { "update:modelValue": { label: "Photo changed", payload: "{ value } - the stored file's id" } },
    expose: ["open", "close"],
  },
  TSignature: {
    label: "Signature",
    source: "totalbase",
    icon: "i-lucide-signature",
    group: "input",
    description: "A pad to sign on with a finger or the mouse - stored as a PNG file, its value the file's id, like a Camera's. Clear starts over; a few ink colors. In a modal behind a button, with the signature shown on the page by a read-only Signature or Camera on the same column.",
    accepts: ["file"],
    formField: true,
    props: {
      modelValue,
      height: { label: "Height", editor: "number", description: "The pad's height in pixels (default 180) - it takes the field's width." },
      colors: { label: "Ink colors", editor: "boolean", description: "A few colors to pick the ink from - off: black only." },
      readonly: { label: "Read only", editor: "boolean", binding: "formula", description: "The signature shown, never changed - no pad, no Clear." },
      disabled,
    },
    slots: {},
    emits: { "update:modelValue": { label: "Signed", payload: "{ value } - the stored file's id, null when cleared" } },
    expose: ["clear", "submit"],
  },
  UEditor: {
    label: "Rich text",
    source: "nuxt-ui",
    icon: "i-lucide-file-text",
    group: "input",
    description: "A rich text editor - Markdown, HTML or JSON content.",
    sizable: true,
    accepts: ["text", "json"],
    formField: true,
    props: { modelValue, contentType: { label: "Content type", editor: "select", options: ["markdown", "html", "json"] } },
    slots: {},
    emits: { "update:modelValue": { label: "Value changed", payload: "{ value }" } },
  },
  TJson: {
    label: "JSON",
    source: "totalbase",
    icon: "i-lucide-braces",
    group: "input",
    description: "Structured data, edited as a tree.",
    sizable: true,
    accepts: ["json"],
    formField: true,
    props: { modelValue, disabled },
    slots: {},
    emits: { "update:modelValue": { label: "Value changed", payload: "{ value }" } },
  },
  TColorSelect: {
    label: "Color",
    source: "totalbase",
    icon: "i-lucide-palette",
    group: "input",
    description: "A palette color or any hex color.",
    accepts: ["text"],
    formField: true,
    props: { modelValue, clearable: { label: "Clear button", editor: "boolean", description: "An ✕ that empties the value." }, disabled },
    slots: {},
    emits: { "update:modelValue": { label: "Value changed", payload: "{ value }" } },
  },
  TUuidInput: {
    label: "UUID",
    source: "totalbase",
    icon: "i-lucide-key-round",
    group: "input",
    description: "A text field for a UUID, with an icon inside that generates a new one: random (v4) or ordered by when it was made (v7).",
    accepts: ["text"],
    formField: true,
    props: {
      modelValue,
      format: {
        label: "Format",
        editor: "select",
        options: ["v4", "v7"],
        description: "What the icon generates. v4: random. v7: ordered by when it was made - what PostgreSQL 18's uuidv7() makes, an index on it grows in order.",
      },
      disabled,
    },
    slots: {},
    emits: { "update:modelValue": { label: "Value changed", payload: "{ value }" } },
  },
  TUlidInput: {
    label: "ULID",
    source: "totalbase",
    icon: "i-lucide-key-square",
    group: "input",
    description: "A text field for a ULID - 26 characters that, sorted ascending, follow the order they were made in - with an icon inside that generates a new one.",
    accepts: ["text"],
    formField: true,
    props: { modelValue, disabled },
    slots: {},
    emits: { "update:modelValue": { label: "Value changed", payload: "{ value }" } },
  },
  TPasswordInput: {
    label: "Password",
    source: "totalbase",
    icon: "i-lucide-lock",
    group: "input",
    description: "A password field, with an eye that shows what was typed. A stored password is never shown - only its hash is kept, and it is never read.",
    accepts: ["text"],
    formField: true,
    props: {
      modelValue,
      revealable: { label: "Show button", editor: "boolean", default: true, description: "An eye that shows or hides what was typed in the field." },
      disabled,
    },
    slots: {},
    emits: { "update:modelValue": { label: "Value changed", payload: "{ value }" } },
  },
  TLeafletMap: {
    label: "Map (Leaflet)",
    source: "totalbase",
    icon: "i-lucide-map-pin",
    group: "input",
    description: "A point picked on an OpenStreetMap map - or the device's own position, with My location.",
    sizable: true,
    accepts: ["point"],
    formField: true,
    props: {
      modelValue,
      locate: { label: "My location", editor: "boolean", default: true, description: "A button over the map that pins the device's position - still draggable after. The browser allows it only over HTTPS (or on localhost)." },
      locateOnOpen: { label: "Locate on open", editor: "boolean", default: false, description: "Pins the device's position when the field opens with no value." },
      disabled,
    },
    slots: {},
    emits: {
      "update:modelValue": { label: "Point changed", payload: "{ value } - { lng, lat }" },
      located: { label: "Located", payload: "{ lng, lat, accuracy } - the device's position, accuracy in meters" },
      locateFailed: { label: "Location failed", payload: "{ reason, message } - insecure, unsupported, denied, unavailable or timeout" },
    },
    expose: ["locate"],
  },
  TGeolocation: {
    label: "Location",
    source: "totalbase",
    icon: "i-lucide-locate-fixed",
    group: "input",
    description: "The device's position into a point column, no map - a button, the coordinates once captured. Auto takes it when the field opens empty: where a reading was taken.",
    accepts: ["point"],
    formField: true,
    props: {
      modelValue,
      auto: { label: "Automatic", editor: "boolean", default: true, description: "Captures the position when the field opens with no value. The browser allows it only over HTTPS (or on localhost), and asks the viewer once." },
      showCoordinates: { label: "Show coordinates", editor: "boolean", default: true, description: "Latitude and longitude beside the button once there's a value." },
      highAccuracy: { label: "High accuracy", editor: "boolean", default: true, description: "GPS over the network's guess - slower, exact." },
      label: { ...text("Label"), description: "The button's - unset: Mark position, then Again." },
      icon: { ...icon, description: "The button's icon - unset: a crosshair." },
      color,
      variant: variant(["solid", "outline", "soft", "subtle", "ghost", "link"]),
      size,
      disabled,
    },
    slots: {},
    emits: {
      "update:modelValue": { label: "Position changed", payload: "{ value } - { lng, lat }" },
      located: { label: "Located", payload: "{ lng, lat, accuracy } - the device's position, accuracy in meters" },
      locateFailed: { label: "Location failed", payload: "{ reason, message } - insecure, unsupported, denied, unavailable or timeout" },
    },
    expose: ["locate"],
  },
  TRangeInput: {
    label: "Range",
    source: "totalbase",
    icon: "i-lucide-move-horizontal",
    group: "input",
    description: "A PostgreSQL range - from and to, with the date or number inputs its type takes; empty, no value.",
    accepts: ["range"],
    formField: true,
    props: { modelValue, disabled },
    slots: {},
    emits: { "update:modelValue": { label: "Range changed", payload: "{ value } - its PostgreSQL text: [from,to)" } },
  },

  // Data display
  TImage: {
    label: "Image",
    source: "totalbase",
    icon: "i-lucide-image",
    group: "display",
    description: "An image - one uploaded here, a file of the record ({{vars.record.data.foto}}) or a URL; with its caption, an icon or a text when there's none, and Clicked to use it as a button.",
    props: {
      src: {
        label: "Image",
        editor: "image",
        binding: "formula",
        description: "A file's id or an https URL. Uploaded here, it's a public file - anyone who opens the page sees it. A formula: a file column of the record, {{vars.record.data.foto}}.",
      },
      alt: { ...text("Alternative text"), binding: "formula", description: "What it shows, for a screen reader - and if it can't load." },
      caption: { ...text("Caption"), binding: "formula", description: "A line under it." },
      aspect: { label: "Shape", editor: "select", options: ["original", "1:1", "3:4", "4:3", "16:9"], default: "original", description: "original keeps the image's own shape; a ratio frames it." },
      fit: { label: "Fit", editor: "select", options: ["cover", "contain"], default: "contain", description: "In a frame: contain shows all of it; cover fills it, cropping." },
      height: { label: "Height", editor: "number", description: "In pixels - unset: its width and shape decide." },
      maxWidth: { label: "Largest width", editor: "number", description: "In pixels - unset: the field's width." },
      corners: { label: "Corners", editor: "select", options: ["none", "sm", "md", "lg", "xl", "full"], default: "md", description: "How round the image's corners are - full: a circle (or a pill). The Style tab's Radius rounds its box." },
      emptyIcon: { label: "Icon when empty", editor: "icon", description: "Shown when there's no image - unset: a picture icon." },
      emptyText: { ...text("Text when empty"), binding: "formula", description: "A line beside that icon." },
    },
    slots: {},
    emits: { click: { label: "Clicked", payload: "- the image clicked or tapped (it then reads as a button)" } },
  },
  THeading: {
    label: "Heading",
    source: "totalbase",
    icon: "i-lucide-heading",
    group: "display",
    description: "A section title.",
    props: { label: text("Text"), level: { label: "Level", editor: "select", options: ["h1", "h2", "h3", "h4", "h5", "h6"] } },
    slots: {},
    emits: {},
  },
  TText: {
    label: "Text",
    source: "totalbase",
    icon: "i-lucide-pilcrow",
    group: "display",
    description: "A paragraph - its content can be a formula.",
    props: { label: text("Text") },
    slots: {},
    emits: {},
  },
  TQrCode: {
    label: "QR code",
    source: "totalbase",
    icon: "i-lucide-qr-code",
    group: "display",
    description: "A QR code of a value - drawn in the browser, never sent anywhere: a device's pairing code, a link. Empty, it says so instead of an unreadable code.",
    props: {
      value: { label: "Value", editor: "text", binding: "formula", description: "What the code holds - a formula: {{vars.record.data.serial_number}}, or a JSON or a URL with it." },
      size: { label: "Size", editor: "number", description: "Its side in pixels (default 200)." },
      errorCorrection: {
        label: "Error correction",
        editor: "select",
        options: ["L", "M", "Q", "H"],
        description: "How much of it may be lost and still read - L 7 %, M 15 % (default), Q 25 %, H 30 %; more makes it denser.",
      },
      caption: { ...text("Caption"), description: "Text under it - the code itself, to type it when it can't be scanned." },
      download: { label: "Download button", editor: "boolean", description: "A button to save it as an SVG, or print it." },
    },
    slots: {},
    emits: {},
  },
  TResult: {
    label: "Result",
    source: "totalbase",
    icon: "i-lucide-badge-check",
    group: "display",
    description:
      "A large panel for an outcome at a glance - a color, an icon, a title and a description, with a tone and a vibration - shown by the page's Code with dataview.controls.<name>.show({ color, icon, title, description, sound, resetAfter }); it goes back to its waiting state on its own after Reset after seconds. A kiosk's answer to a scan.",
    sizable: true,
    props: {
      idleTitle: { ...text("Waiting title"), description: "What it says while waiting for a result - unset: Ready." },
      idleDescription: { ...text("Waiting description"), description: "A line under it while waiting - e.g. Scan your code." },
      idleIcon: { ...icon, label: "Waiting icon", description: "Its icon while waiting - unset: a scan frame." },
      idleColor: { ...color, label: "Waiting color", default: "neutral", description: "Its color while waiting - one of the theme's colors." },
      resetAfter: {
        label: "Reset after",
        editor: "number",
        binding: "formula",
        default: 5,
        description: "Seconds a result stays before it goes back to waiting - 0: until the next one or reset(). show({ resetAfter }) may change it for one result.",
      },
      variant: { ...variant(SOLID_VARIANTS), default: "solid", description: "How a result fills the panel: solid, outline, soft or subtle. Waiting, it is always soft." },
      size: { label: "Size", editor: "select", options: ["md", "lg", "xl"], default: "lg", description: "Its icon and text, from md to xl." },
      sound: {
        label: "Sound",
        editor: "boolean",
        default: true,
        description: "A tone with each result - a rising one for success, a low one for error and warning; show({ sound: \"success\" | \"error\" | false }) may choose.",
      },
      vibrate: { label: "Vibrate", editor: "boolean", default: true, description: "A vibration with each result, where the device can - longer for an error." },
    },
    slots: {},
    emits: { reset: { label: "Back to waiting", payload: "- it shows its waiting state again (Reset after, or reset())" } },
    expose: ["show", "reset"],
  },
  UTable: {
    label: "Table",
    source: "nuxt-ui",
    icon: "i-lucide-table",
    group: "display",
    description: "Rows of a Resource - its columns are the Resource's fields.",
    sizable: true,
    setup: "resource",
    props: {
      data: { label: "Rows", editor: "json", binding: "resource" },
      // TotalBase's own (DataViews.md §15): each column's settings, Nuxt UI never sees them.
      columnSettings: {
        label: "Columns",
        editor: "tableColumns",
        description: "Each column's title, format and look - what isn't set comes from its resource's column. In its Rows' order; a hidden one still comes with Row clicked's row.",
      },
      // TotalBase's own as well: columns computed per row, after its Resource's.
      computedColumns: {
        label: "Computed columns",
        editor: "computedColumns",
        description: "A formula per row - {{quantity}} * {{unit_price}} - shown after its Rows' fields; its look in Columns. A total that must add up belongs in PostgreSQL.",
      },
      // TotalBase's own as well: each row tinted, from a field or a formula per row.
      rowColorKey: {
        label: "Row color",
        editor: "resourceField",
        binding: "option",
        description: 'Tints each row - a field holding a palette color (red, green...), or a formula: {{vencida}} ? "red" : "".',
      },
      // TotalBase's own as well: a last column of icon buttons, its renderer's.
      actions: {
        label: "Row actions",
        editor: "actions",
        description: "Icon buttons at the end of each row - Action clicked tells which by its Name; each may be off or hidden by a formula per row.",
      },
      sticky: { label: "Sticky header", editor: "boolean", description: "The column titles stay in view while scrolling." },
      // TotalBase's own as well: the server searches and pages its Resource.
      search: { label: "Search", editor: "boolean", description: "A search box over its Rows' Resource - the server searches its text fields." },
      searchBlock: { label: "Full-width search", editor: "boolean", description: "The search box as wide as the table - in a modal or a sidebar." },
      pager: { label: "Pager", editor: "boolean", description: "Pages through its Rows' Resource on the server - its limit is the page size; with Count the total, too." },
      loading,
      empty: text("Empty text"),
    },
    // Edited apart: on the canvas the Table shows its columns, so its no-rows content opens on its own.
    slots: { empty: { label: "Empty", canvas: "own" } },
    emits: {
      select: { label: "Row clicked", payload: "{ row }" },
      action: { label: "Action clicked", payload: "{ action, row } - `action` is the clicked button's Name" },
      // TotalBase's own: Enter in its Search box, once its Resource has read what was typed.
      searchEnter: { label: "Search Enter", payload: "{ search, rows, row } - the rows its search found, `row` the first (null when none)" },
    },
  },
  UBadge: {
    label: "Badge",
    source: "nuxt-ui",
    icon: "i-lucide-tag",
    group: "display",
    description: "A short label.",
    props: { label: text("Label"), color, variant: variant(SOLID_VARIANTS), size, icon, square: { label: "Square", editor: "boolean", description: "As wide as it is tall - for an icon alone." } },
    slots: {},
    emits: {},
  },
  UAlert: {
    label: "Alert",
    source: "nuxt-ui",
    icon: "i-lucide-triangle-alert",
    group: "display",
    description: "A message with a title and a description.",
    props: {
      title: text("Title"),
      description: text("Description"),
      icon,
      color,
      variant: variant(SOLID_VARIANTS),
      orientation,
      close: { label: "Close button", editor: "boolean", description: "An ✕ in its corner that closes it." },
    },
    slots: { actions: { label: "Actions" } },
    emits: { "update:open": { label: "Closed", payload: "{ open }" } },
  },
  USeparator: {
    label: "Separator",
    source: "nuxt-ui",
    icon: "i-lucide-minus",
    group: "display",
    description: "A rule between sections, with an optional label.",
    props: {
      label: text("Label"),
      icon,
      color,
      size,
      type: { label: "Line", editor: "select", options: ["solid", "dashed", "dotted"] },
      orientation,
    },
    slots: {},
    emits: {},
  },
  UProgress: {
    label: "Progress",
    source: "nuxt-ui",
    icon: "i-lucide-loader",
    group: "display",
    description: "A progress bar.",
    props: {
      modelValue: { label: "Value", editor: "number", binding: "formula" },
      max: { label: "Max", editor: "number", binding: "formula" },
      status: { label: "Show the value", editor: "boolean", description: "Shows the value as a number beside the bar." },
      color,
      size,
      orientation,
    },
    slots: {},
    emits: {},
  },
  UAvatar: {
    label: "Avatar",
    source: "nuxt-ui",
    icon: "i-lucide-circle-user",
    group: "display",
    description: "An image, initials or an icon in a circle.",
    props: { src: text("Image"), alt: text("Alternative text"), text: text("Initials"), icon, size },
    slots: {},
    emits: {},
  },
  UUser: {
    label: "User",
    source: "nuxt-ui",
    icon: "i-lucide-user",
    group: "display",
    description: "A name and a description beside an avatar.",
    // `avatar` is a URL here - its renderer passes Nuxt UI { src, alt }.
    props: { name: text("Name"), description: text("Description"), avatar: { ...text("Image"), description: "Its avatar's image URL - empty shows the name's initials." }, size, orientation },
    slots: {},
    emits: { click: { label: "Click" } },
  },
  UEmpty: {
    label: "Empty state",
    source: "nuxt-ui",
    icon: "i-lucide-inbox",
    group: "display",
    description: 'An icon, a title and a description for "nothing here yet".',
    props: {
      title: text("Title"),
      description: text("Description"),
      icon,
      loading,
      variant: variant(["solid", "outline", "soft", "subtle", "naked"]),
      size,
    },
    slots: { actions: { label: "Actions" } },
    emits: {},
  },
  UIcon: {
    label: "Icon",
    source: "nuxt-ui",
    icon: "i-lucide-smile",
    group: "display",
    description: "A single icon.",
    props: { name: { label: "Icon", editor: "icon", binding: "formula", description: "The icon to show." } },
    slots: {},
    emits: {},
  },

  // Containers - their slots are drop zones
  UCard: {
    label: "Card",
    source: "nuxt-ui",
    icon: "i-lucide-square",
    group: "container",
    description: "A framed section with a header and a footer.",
    fillable: true,
    props: { title: text("Title"), description: text("Description"), variant: variant(SOLID_VARIANTS) },
    slots: { header: { label: "Header" }, default: { label: "Body" }, footer: { label: "Footer" } },
    emits: {},
  },
  TBox: {
    label: "Box",
    source: "totalbase",
    icon: "i-lucide-square-dashed",
    group: "container",
    // Nuxt UI has no plain container (UContainer only centers and caps the width): a Card brings its header, footer and frame.
    description: "A plain area grouping widgets - no frame of its own: its look is its Style (padding, border, background, radius).",
    fillable: true,
    props: {},
    slots: { default: { label: "Content" } },
    emits: {},
  },
  UTabs: {
    label: "Tabs",
    source: "nuxt-ui",
    icon: "i-lucide-panel-top",
    group: "container",
    description: "Sections one at a time, under a tab strip.",
    props: {
      items: {
        label: "Tabs",
        editor: "items",
        itemFields: ["icon", "disabled", "visible"],
        description: 'Its label may be a formula - "Items (" + {{vars.items.count}} + ")"; one off until a customer is picked, another shown only to some.',
      },
      modelValue: { label: "Open tab", editor: "text", binding: "value", description: "A Value holding the open tab's key - set it from Code to switch tabs; empty opens the first." },
      color,
      variant: variant(["pill", "link"]),
      size,
      orientation,
    },
    defaults: { items: [{ label: "Tab 1", value: "tab1" }, { label: "Tab 2", value: "tab2" }] },
    slots: { content: { label: "Tab content", slotProps: ["item", "index"], perItem: true } },
    emits: { "update:modelValue": { label: "Tab changed", payload: "{ value }" } },
  },
  UAccordion: {
    label: "Accordion",
    source: "nuxt-ui",
    icon: "i-lucide-list-collapse",
    group: "container",
    description: "Sections that expand one (or several) at a time.",
    props: {
      items: { label: "Sections", editor: "items", itemFields: ["icon", "disabled", "visible"], description: "Its label may be a formula; one off or hidden by a formula over the page." },
      modelValue: { label: "Open sections", editor: "text", binding: "value", description: "A Value holding the open section's key - a list of them with Open: multiple. Set it from Code to open one." },
      type: { label: "Open", editor: "select", options: ["single", "multiple"] },
      disabled,
    },
    defaults: { items: [{ label: "Section 1", value: "section1" }, { label: "Section 2", value: "section2" }] },
    slots: { body: { label: "Section body", slotProps: ["item", "index"], perItem: true } },
    emits: { "update:modelValue": { label: "Section toggled", payload: "{ value }" } },
  },
  UCollapsible: {
    label: "Collapsible",
    source: "nuxt-ui",
    icon: "i-lucide-chevrons-down-up",
    group: "container",
    description: "A trigger that shows or hides its content.",
    props: { defaultOpen: { label: "Open at first", editor: "boolean", description: "Starts expanded." }, disabled },
    slots: { default: { label: "Trigger" }, content: { label: "Content" } },
    emits: { "update:open": { label: "Opened / closed", payload: "{ open }" } },
    expose: ["open", "close"],
  },
  USplitter: {
    label: "Splitter",
    source: "nuxt-ui",
    icon: "i-lucide-columns-2",
    group: "container",
    description: "Panels side by side, or one above the other - the viewer drags what's between them; each panel scrolls on its own.",
    sizable: true,
    props: {
      items: {
        label: "Panels",
        editor: "items",
        itemFields: ["size", "minSize", "collapsible"],
        description: "One per panel - its label names it on the canvas; its size and minimum in % of the whole, the sizes summing to 100 (changing one reshares the rest); Collapsible lets the viewer drag it shut.",
      },
      orientation,
      disabled: { label: "Locked", editor: "boolean", description: "The panels keep their sizes - nothing to drag." },
    },
    defaults: { items: [{ value: "left", label: "Left", defaultSize: 40, minSize: 20 }, { value: "right", label: "Right", defaultSize: 60, minSize: 20 }] },
    slots: { panel: { label: "Panel", slotProps: ["item", "index"], perItem: true } },
    emits: {},
  },
  UScrollArea: {
    label: "Scroll area",
    source: "nuxt-ui",
    icon: "i-lucide-gallery-vertical-end",
    group: "container",
    description: "A box with its own height that scrolls what it holds - its look from the Style tab.",
    sizable: true,
    props: {
      orientation,
      shadow: { label: "Edge shadows", editor: "boolean", description: "A fade at the edges while there's more to scroll." },
    },
    slots: { default: { label: "Content" } },
    emits: {},
  },

  // Overlays - opened by code (`open()`) or their trigger
  UModal: {
    label: "Modal",
    source: "nuxt-ui",
    icon: "i-lucide-app-window",
    group: "overlay",
    description: "A dialog over the page.",
    props: {
      title: text("Title"),
      description: text("Description"),
      size: overlaySize,
      fullscreen: { label: "Fullscreen", editor: "boolean", description: "Covers the whole screen." },
      dismissible: { label: "Close on outside click", editor: "boolean", description: "Closes when the viewer clicks outside it." },
      close: { label: "Close button", editor: "boolean", description: "An ✕ in its corner that closes it." },
      scrollable: { label: "Scroll the whole modal", editor: "boolean", description: "The whole modal scrolls, not only its body." },
    },
    slots: { header: { label: "Header", canvas: "own" }, body: { label: "Body", canvas: "own" }, footer: { label: "Footer", canvas: "own" } },
    emits: overlayEmits,
    expose: ["open", "close"],
  },
  USlideover: {
    label: "Slideover",
    source: "nuxt-ui",
    icon: "i-lucide-panel-right",
    group: "overlay",
    description: "A panel sliding in from an edge.",
    props: {
      title: text("Title"),
      description: text("Description"),
      side: { label: "Side", editor: "select", options: ["right", "left", "top", "bottom"] },
      size: overlaySize,
      inset: { label: "Inset", editor: "boolean", description: "Floats with a margin from the edge of the screen." },
      dismissible: { label: "Close on outside click", editor: "boolean", description: "Closes when the viewer clicks outside it." },
      close: { label: "Close button", editor: "boolean", description: "An ✕ in its corner that closes it." },
    },
    slots: { header: { label: "Header", canvas: "own" }, body: { label: "Body", canvas: "own" }, footer: { label: "Footer", canvas: "own" } },
    emits: overlayEmits,
    expose: ["open", "close"],
  },
  TDrawer: {
    label: "Drawer",
    source: "totalbase",
    icon: "i-lucide-panel-bottom",
    group: "overlay",
    description: "A panel rising from the bottom - TotalBase's own drawer, for working on something with room.",
    props: {
      title: text("Title"),
      description: text("Description"),
      size: { label: "Size", editor: "select", options: ["sm", "md", "lg", "xl"], description: "Its width, from sm to xl - lg by default, as every drawer in TotalBase." },
      expandable: { label: "Expand button", editor: "boolean", default: true, description: "A button that grows it to almost the whole screen." },
      startExpanded: { label: "Open expanded", editor: "boolean", description: "Opens at almost the whole screen - for content that needs the room." },
    },
    slots: { body: { label: "Body", canvas: "own" }, footer: { label: "Footer", canvas: "own" } },
    // AppDrawer has no after-leave of its own.
    emits: { "update:open": overlayEmits["update:open"] },
    expose: ["open", "close"],
  },
  UPopover: {
    label: "Popover",
    source: "nuxt-ui",
    icon: "i-lucide-message-square",
    group: "overlay",
    description: "A small panel anchored to its trigger.",
    props: { mode: { label: "Opens on", editor: "select", options: ["click", "hover"] }, arrow: { label: "Arrow", editor: "boolean", description: "A small arrow pointing at what opened it." } },
    slots: { default: { label: "Trigger" }, content: { label: "Content", canvas: "own" } },
    emits: { "update:open": { label: "Opened / closed", payload: "{ open }" } },
    expose: ["open", "close"],
  },
  UTooltip: {
    label: "Tooltip",
    source: "nuxt-ui",
    icon: "i-lucide-message-circle-question",
    group: "overlay",
    description: "A hint shown over its content on hover.",
    props: { text: text("Text"), arrow: { label: "Arrow", editor: "boolean", description: "A small arrow pointing at what opened it." } },
    slots: { default: { label: "Content" } },
    emits: {},
  },
  UDropdownMenu: {
    label: "Dropdown menu",
    source: "nuxt-ui",
    icon: "i-lucide-ellipsis-vertical",
    group: "overlay",
    description: "A menu of actions under its trigger - each item runs a Code function.",
    props: {
      items: {
        label: "Items",
        editor: "items",
        itemFields: ["icon", "color", "function", "disabled", "visible"],
        description: "Each runs its Code function - Cancel off once it's paid, Delete only for some: a formula over the page.",
      },
      size,
      disabled,
    },
    slots: { default: { label: "Trigger" } },
    emits: { "update:open": { label: "Opened / closed", payload: "{ open }" } },
  },

  // Actions
  UButton: {
    label: "Button",
    source: "nuxt-ui",
    icon: "i-lucide-square-mouse-pointer",
    group: "action",
    description: "Runs a Code function on click.",
    props: {
      label: text("Label"),
      color,
      variant: variant(["solid", "outline", "soft", "subtle", "ghost", "link"]),
      size,
      icon,
      trailingIcon,
      type: { label: "Type", editor: "select", options: ["button", "submit", "reset"], description: "Submit sends the form it is in." },
      square: { label: "Square", editor: "boolean", description: "As wide as it is tall - for an icon alone." },
      block: { label: "Full width", editor: "boolean", description: "Fills the width of its container." },
      loading,
      disabled,
    },
    slots: {},
    emits: { click: { label: "Click" } },
  },
} as const satisfies Record<string, WidgetDefinition>;

export type WidgetName = keyof typeof WIDGET_CATALOG;

/**
 * TotalBase's own props, on every placed widget besides its component's:
 * whether it shows, CSS classes and HTML attributes on it (the old Design
 * form's Advanced tab), and - on inputs - Read only. Not Nuxt UI props, so
 * not in a widget's `props` (widget-catalog.check.ts checks those against
 * Nuxt UI's types): the renderer applies them itself.
 */
export const COMMON_WIDGET_PROPS = {
  visible: {
    label: "Visible",
    editor: "boolean",
    binding: "formula",
    default: true,
    description: "Off - or a formula giving false - it leaves the page: no space, and its methods (dataview.controls.<name>.open()) and what it listens to (a Scanner's USB reader) stop. Hidden, still active keeps it working unseen.",
  },
  keepActive: {
    label: "Hidden, still active",
    editor: "boolean",
    description: "Hidden by Visible, it stays on the page unseen - its methods and what it listens to keep working: a scanner listening to the page, a modal opened by code.",
  },
  cssClass: { label: "CSS classes", editor: "text", description: "Tailwind classes on its box, beyond the Style tab's - spacing, text, layout." },
  htmlAttrs: { label: "HTML attributes", editor: "attributes", description: "Extra attributes on the widget, e.g. data-test or title." },
} as const satisfies Record<string, WidgetProp>;

/**
 * The Style tab (DataViews.md §12.6): the box around
 * any placed widget - spacing, border, background, shadow, alignment - from
 * fixed scales of the theme's own tokens, so a page stays consistent, dark
 * mode included. Unset is none. The renderer turns each into Tailwind classes
 * (the admin's utils/widget-style.ts); its component never sees them.
 */
const SPACING = ["xs", "s", "m", "l", "xl"] as const;
export const COMMON_STYLE_PROPS = {
  // Space outside its box, all sides or one - a side wins over All. Left and right narrow it within its columns, never out of them.
  margin: { label: "Margin", editor: "select", options: SPACING },
  marginTop: { label: "Margin top", editor: "select", options: SPACING },
  marginBottom: { label: "Margin bottom", editor: "select", options: SPACING },
  marginLeft: { label: "Margin left", editor: "select", options: SPACING },
  marginRight: { label: "Margin right", editor: "select", options: SPACING },
  // Space inside its box, around its content - all sides or one.
  padding: { label: "Padding", editor: "select", options: SPACING },
  paddingTop: { label: "Padding top", editor: "select", options: SPACING },
  paddingBottom: { label: "Padding bottom", editor: "select", options: SPACING },
  paddingLeft: { label: "Padding left", editor: "select", options: SPACING },
  paddingRight: { label: "Padding right", editor: "select", options: SPACING },
  border: { label: "Border", editor: "select", options: ["muted", "accented", "primary"], description: "A line around its box." },
  radius: { label: "Radius", editor: "select", options: ["s", "m", "l", "full"], description: "Its box's rounded corners." },
  background: { label: "Background", editor: "select", options: ["muted", "elevated", "accented", "primary"], description: "Its box's color - the theme's, light and dark." },
  shadow: { label: "Shadow", editor: "select", options: ["s", "m", "l"], description: "Lifts its box off the page." },
  align: { label: "Align content", editor: "select", options: ["start", "center", "end"], description: "Its text and buttons, left to right." },
  verticalAlign: {
    label: "Vertical align",
    editor: "select",
    options: ["top", "center", "bottom", "stretch"],
    description: "Where it sits in its row, beside a taller widget - stretch: a Card or a Box takes the row's height, even with the one beside it.",
  },
} as const satisfies Record<string, WidgetProp>;

/** Common to input widgets only - they hold a value a viewer could otherwise change. */
export const COMMON_INPUT_PROPS = {
  readonly: { label: "Read only", editor: "boolean", binding: "formula", description: "Shown, but can't be changed." },
} as const satisfies Record<string, WidgetProp>;

/** Common to sizable widgets only - they have a height of their own (DataViews.md §12.2). */
export const COMMON_SIZABLE_PROPS = {
  fillHeight: {
    label: "Fill height",
    editor: "boolean",
    description: "Takes the height the page has left, so everything fits on screen - a Detail's rows, an editor. Its own height is then the least it takes.",
  },
} as const satisfies Record<string, WidgetProp>;

/** Common to fillable containers only (a Card, a Box): Fill height, and no Height of their own. */
export const COMMON_FILLABLE_PROPS = {
  fillHeight: {
    label: "Fill height",
    editor: "boolean",
    description: "Takes the height the page or panel has left - what it holds scrolls inside it (a Card's body, between its header and footer). A widget in it with Fill height fills it.",
  },
} as const satisfies Record<string, WidgetProp>;

/** The common props `name` has (COMMON_WIDGET_PROPS and COMMON_STYLE_PROPS, plus COMMON_INPUT_PROPS on an input, COMMON_SIZABLE_PROPS on a sizable widget and COMMON_FILLABLE_PROPS on a fillable container). */
export function commonWidgetProps(name: WidgetName): Readonly<Record<string, WidgetProp>> {
  const entry: WidgetDefinition = WIDGET_CATALOG[name];
  return {
    ...(entry.group === "input" ? COMMON_INPUT_PROPS : {}),
    ...(entry.sizable ? COMMON_SIZABLE_PROPS : {}),
    ...(entry.fillable ? COMMON_FILLABLE_PROPS : {}),
    ...COMMON_WIDGET_PROPS,
    ...COMMON_STYLE_PROPS,
  };
}
export const WIDGET_NAMES = Object.keys(WIDGET_CATALOG) as WidgetName[];

/**
 * A CUSTOM page's header (DataViews.md §12.2):
 * widgets on the page with this slot show in the App page's own header,
 * beside its title - its actions, so only those that act.
 */
export const PAGE_HEADER_SLOT = "header";
export const PAGE_HEADER_WIDGETS: readonly WidgetName[] = ["UButton", "UDropdownMenu"];

/**
 * A CUSTOM page's footer (DataViews.md §12.2):
 * widgets on the page with this slot show pinned under it - the page
 * scrolls, they stay (totals and an action). A low band: buttons, menus,
 * text, badges, and a Box to group more (its own content is free). Nothing
 * there, no footer.
 */
export const PAGE_FOOTER_SLOT = "footer";
export const PAGE_FOOTER_WIDGETS: readonly WidgetName[] = ["UButton", "UDropdownMenu", "TText", "UBadge", "TBox"];

export function isWidgetName(name: string): name is WidgetName {
  return Object.prototype.hasOwnProperty.call(WIDGET_CATALOG, name);
}

/** A stored slot name's catalog slot: `content:tab1` → `content`. */
export function slotBase(slot: string): string {
  const colon = slot.indexOf(":");
  return colon === -1 ? slot : slot.slice(0, colon);
}

/** The area key of a per-item slot for one item: `content:<value>`, else `content:<index>`. */
export function itemSlot(slot: string, item: unknown, index: number): string {
  const value = item !== null && typeof item === "object" ? (item as { value?: unknown }).value : undefined;
  return `${slot}:${typeof value === "string" || typeof value === "number" ? value : index}`;
}

/** What a named widget holds, read by formulas as `{{controls.<name>.*}}` (DataViews.md §9.2). */
export interface WidgetStateEntry {
  label: string;
  description: string;
}

/** The option lists whose `item` is one chosen row - a Checkbox group's value is always several. */
const SINGLE_OPTION_WIDGETS: readonly WidgetName[] = ["USelect", "USelectMenu", "UInputMenu", "URadioGroup", "UListbox"];

/**
 * What `name` exposes to formulas: every widget with a Value (`modelValue`)
 * its `value`; an option list also its `item`, the chosen option's row; a
 * Table its `row`, the last one clicked. Derived from its props, so a new
 * input exposes its value with nothing to add here.
 */
export function widgetState(name: WidgetName): Readonly<Record<string, WidgetStateEntry>> {
  const props: Readonly<Record<string, WidgetProp>> = widgetDefinition(name).props;
  const state: Record<string, WidgetStateEntry> = {};
  if (props.modelValue?.binding === "value") state.value = { label: "Value", description: "What it holds now." };
  if (SINGLE_OPTION_WIDGETS.includes(name)) state.item = { label: "Item", description: "The chosen option's whole row - its fields as .campo; null with none (or several)." };
  if (name === "UTable") state.row = { label: "Row", description: "The last row clicked - its fields as .campo; null until one is." };
  return state;
}

/** A widget's definition, widened from its literal type - for code that walks any widget's props, slots or emits. */
export function widgetDefinition(name: WidgetName): WidgetDefinition {
  return WIDGET_CATALOG[name];
}
