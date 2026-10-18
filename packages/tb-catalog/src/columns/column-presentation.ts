import { isRecord } from "@totalbase/shared";
import { WIDGET_COLORS, type ValueKind } from "../widgets/widget-catalog.js";
import { COLUMN_INPUT_KEYS, COLUMN_INPUTS } from "./column-inputs.js";

/**
 * How a column reads wherever it shows (Specification_DataViews.md §15):
 * set once on the resource's column
 * (`resources_columns.config`), inherited live by grid columns, form fields
 * and Table widgets, each storing only what it overrides. Presentation only -
 * what values are valid is PostgreSQL's (NOT NULL, CHECK), never stored here.
 * Keys are `FieldConfig`'s own names, so an override reads the same way.
 */
export interface ColumnPresentation extends CellStyle {
  label?: string;
  /** A list's header and a card's field name, where room is short (`Cant.`) - the label everywhere else. */
  shortLabel?: string;
  description?: string;
  /** Under its input, in every form that edits it. */
  help?: string;
  /** An example value, inside an empty input. */
  placeholder?: string;
  /** An icon in its input - at its start, or at its end with `iconPosition: "trailing"` (a unit: `i-lucide-percent`). */
  icon?: string;
  iconPosition?: "leading" | "trailing";
  /** A number or a date pattern (`#,##0.00`, `CURRENCY:USD`, `dd/MM/yyyy`) - number, date and time columns. */
  displayFormat?: string;
  /** Shown for no value. */
  emptyText?: string;
  /** A boolean column's text for true and for false - either alone. */
  booleanLabels?: { true?: string; false?: string };
  /** A text column shown as a link to open it. */
  linkType?: "url" | "email" | "tel";
  /** How each value of the column's CHECK list (`status IN ('A', 'I')`) shows - its values stay the CHECK's. */
  options?: Record<string, ColumnOptionPresentation>;
  /**
   * How it looks when something holds (Specification_DataViews.md §15.7): an ordered list - the first that holds
   * wins, per cell and per row (a cell's over a row's), on top of the base style. Evaluated by PostgreSQL (the Data
   * API's `flags`), never in the browser.
   */
  conditions?: ColumnCondition[];
  /**
   * The control every form edits it with - a key of the column input catalog (`COLUMN_INPUTS`: `number-field`,
   * `email`, `relation-select`), one that edits its kind of value. Unset, `columnFormInput`'s rule decides
   * (Automatic). Add Column sets it; a form field follows it until it picks its own (§15.2).
   */
  input?: string;
}

export const CONDITION_APPLY_TO = ["cell", "row"] as const;

/** One condition: its name, a filter in the `where` grammar, where it applies and how it looks then. */
export interface ColumnCondition {
  name: string;
  /** Off keeps it, unevaluated. */
  enabled?: boolean;
  /** A filter object - the Data API's `where` grammar (`$ROW`, `$USER`, `$CURRENT_DATE`, `$PERIOD`, paths by FK). */
  where: Record<string, unknown>;
  /** The cell (the default) or the whole row. */
  applyTo?: (typeof CONDITION_APPLY_TO)[number];
  style: ConditionStyle;
}

/** A condition's look: a cell's style, plus an icon before the value, the value as a badge, or dimmed. */
export interface ConditionStyle extends CellStyle {
  icon?: string;
  badge?: boolean;
  dim?: boolean;
}

/**
 * The palette a cell's text color comes from - Tailwind's hues, the same
 * as a role's color (@totalbase/permissions' ROLE_COLOR_OPTIONS) and a
 * Dashboard table's column color (ColorPickerField).
 */
export const PALETTE_COLORS = [
  "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan",
  "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose",
] as const;
export type PaletteColor = (typeof PALETTE_COLORS)[number];

export const CELL_ALIGNS = ["left", "center", "right"] as const;
export const CELL_FONT_SIZES = ["xs", "sm", "base", "lg"] as const;

/**
 * How a column's cells look in a table - a DataView's grid, a page's
 * Table, a Dashboard's TABLE. Read-only cells only: an input's look is
 * the theme's. Unset keeps the type's default (numbers right-aligned).
 */
export interface CellStyle {
  align?: (typeof CELL_ALIGNS)[number];
  fontSize?: (typeof CELL_FONT_SIZES)[number];
  bold?: boolean;
  italic?: boolean;
  mono?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: PaletteColor;
  /** A tint of a palette color behind the cell. */
  background?: PaletteColor;
}

/** One value of a CHECK list: its text, its color (the theme's) and its icon - each optional. */
export interface ColumnOptionPresentation {
  label?: string;
  color?: (typeof WIDGET_COLORS)[number];
  icon?: string;
}

export type ColumnPresentationKey = keyof ColumnPresentation;

export const COLUMN_PRESENTATION_KEYS: readonly ColumnPresentationKey[] = [
  "label",
  "shortLabel",
  "description",
  "help",
  "placeholder",
  "icon",
  "iconPosition",
  "displayFormat",
  "emptyText",
  "booleanLabels",
  "linkType",
  "options",
  "align",
  "fontSize",
  "bold",
  "italic",
  "mono",
  "underline",
  "strike",
  "color",
  "background",
  "conditions",
  "input",
];

export const COLUMN_LINK_TYPES = ["url", "email", "tel"] as const;

const MAX_LENGTH: Record<"label" | "shortLabel" | "description" | "help" | "placeholder" | "displayFormat" | "emptyText" | "booleanLabel" | "optionLabel", number> = {
  label: 64,
  shortLabel: 32,
  description: 256,
  help: 256,
  placeholder: 64,
  displayFormat: 64,
  emptyText: 64,
  booleanLabel: 32,
  optionLabel: 64,
};
const MAX_OPTIONS = 200;
const MAX_CONDITIONS = 20;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
/** An Iconify name, as every icon prop takes it: `i-lucide-mail`. */
const ICON_NAME = /^i-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ICON_LENGTH = 64;

/** Which of the type-bound options a column of `kind` takes - the rest apply to every column. */
export function columnPresentationOptions(kind: ValueKind): {
  displayFormat: boolean;
  booleanLabels: boolean;
  linkType: boolean;
  placeholder: boolean;
  icon: boolean;
} {
  return {
    displayFormat: kind === "number" || kind === "date" || kind === "time" || kind === "timestamp",
    booleanLabels: kind === "boolean",
    linkType: kind === "text",
    // A switch or a checkbox has neither.
    placeholder: kind !== "boolean",
    icon: kind !== "boolean",
  };
}

/** The presentation part of a stored column `config` - whatever else it still holds is left out. */
export function pickColumnPresentation(config: unknown): ColumnPresentation {
  if (!isRecord(config)) return {};
  const picked: Record<string, unknown> = {};
  for (const key of COLUMN_PRESENTATION_KEYS) {
    if (config[key] !== undefined) picked[key] = config[key];
  }
  return picked as ColumnPresentation;
}

/**
 * A column's presentation as sent by the editor, checked for a column of
 * `kind`: known keys only, text trimmed (empty means unset, so it is left
 * out), within its length, no control characters, and only the options its
 * type takes. Returns the clean value, or the problems for the author.
 */
export function validateColumnPresentation(
  input: unknown,
  kind: ValueKind,
): { presentation: ColumnPresentation; errors: string[] } {
  const errors: string[] = [];
  const presentation: ColumnPresentation = {};
  if (!isRecord(input)) return { presentation, errors: ["The presentation must be an object."] };

  for (const key of Object.keys(input)) {
    if (!(COLUMN_PRESENTATION_KEYS as readonly string[]).includes(key)) errors.push(`Unknown option "${key}" - one of: ${COLUMN_PRESENTATION_KEYS.join(", ")}.`);
  }

  const text = (value: unknown, name: string, max: number): string | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") {
      errors.push(`${name} must be text.`);
      return undefined;
    }
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    if (trimmed.length > max) errors.push(`${name} is longer than ${max} characters.`);
    else if (CONTROL_CHARACTERS.test(trimmed)) errors.push(`${name} has a control character.`);
    else return trimmed;
    return undefined;
  };

  const options = columnPresentationOptions(kind);
  const notForType = (name: string) => errors.push(`${name} doesn't apply to a ${kind} column.`);

  const iconName = (value: unknown, name: string): string | undefined => {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value === "string" && value.length <= MAX_ICON_LENGTH && ICON_NAME.test(value)) return value;
    errors.push(`${name} isn't an icon name (i-lucide-mail).`);
    return undefined;
  };

  const label = text(input.label, "Label", MAX_LENGTH.label);
  if (label !== undefined) presentation.label = label;
  const shortLabel = text(input.shortLabel, "Short label", MAX_LENGTH.shortLabel);
  if (shortLabel !== undefined) presentation.shortLabel = shortLabel;
  const description = text(input.description, "Description", MAX_LENGTH.description);
  if (description !== undefined) presentation.description = description;
  const help = text(input.help, "Help", MAX_LENGTH.help);
  if (help !== undefined) presentation.help = help;
  const emptyText = text(input.emptyText, "Empty text", MAX_LENGTH.emptyText);
  if (emptyText !== undefined) presentation.emptyText = emptyText;

  const placeholder = text(input.placeholder, "Placeholder", MAX_LENGTH.placeholder);
  if (placeholder !== undefined) {
    if (options.placeholder) presentation.placeholder = placeholder;
    else notForType("Placeholder");
  }

  const icon = iconName(input.icon, "Icon");
  if (icon !== undefined) {
    if (options.icon) presentation.icon = icon;
    else notForType("Icon");
  }
  if (input.iconPosition !== undefined && input.iconPosition !== null) {
    if (input.iconPosition !== "leading" && input.iconPosition !== "trailing") errors.push("Icon position is leading or trailing.");
    // Leading is the default - only trailing is kept, and only with an icon.
    else if (input.iconPosition === "trailing" && presentation.icon !== undefined) presentation.iconPosition = "trailing";
  }

  const displayFormat = text(input.displayFormat, "Format", MAX_LENGTH.displayFormat);
  if (displayFormat !== undefined) {
    if (options.displayFormat) presentation.displayFormat = displayFormat;
    else notForType("Format");
  }

  if (input.booleanLabels !== undefined && input.booleanLabels !== null) {
    if (!isRecord(input.booleanLabels)) {
      errors.push("True and false labels must be an object.");
    } else {
      const labels: { true?: string; false?: string } = {};
      for (const key of Object.keys(input.booleanLabels)) {
        if (key !== "true" && key !== "false") errors.push(`Unknown true/false label "${key}".`);
      }
      const whenTrue = text(input.booleanLabels.true, "True label", MAX_LENGTH.booleanLabel);
      const whenFalse = text(input.booleanLabels.false, "False label", MAX_LENGTH.booleanLabel);
      if (whenTrue !== undefined) labels.true = whenTrue;
      if (whenFalse !== undefined) labels.false = whenFalse;
      if (Object.keys(labels).length > 0) {
        if (options.booleanLabels) presentation.booleanLabels = labels;
        else notForType("True and false labels");
      }
    }
  }

  if (input.linkType !== undefined && input.linkType !== null && input.linkType !== "") {
    if (!(COLUMN_LINK_TYPES as readonly unknown[]).includes(input.linkType)) errors.push(`Link is one of: ${COLUMN_LINK_TYPES.join(", ")}.`);
    else if (options.linkType) presentation.linkType = input.linkType as (typeof COLUMN_LINK_TYPES)[number];
    else notForType("Link");
  }

  // How its cells look in a table - any type.
  const oneOf = <T extends string>(value: unknown, allowed: readonly T[], name: string): T | undefined => {
    if (value === undefined || value === null || value === "") return undefined;
    if ((allowed as readonly unknown[]).includes(value)) return value as T;
    errors.push(`${name} is one of: ${allowed.join(", ")}.`);
    return undefined;
  };
  const cellStyle = (source: Record<string, unknown>, target: CellStyle, prefix = "") => {
    const align = oneOf(source.align, CELL_ALIGNS, `${prefix}Alignment`);
    if (align !== undefined) target.align = align;
    const fontSize = oneOf(source.fontSize, CELL_FONT_SIZES, `${prefix}Font size`);
    if (fontSize !== undefined) target.fontSize = fontSize;
    const color = oneOf(source.color, PALETTE_COLORS, `${prefix}Color`);
    if (color !== undefined) target.color = color;
    const background = oneOf(source.background, PALETTE_COLORS, `${prefix}Background`);
    if (background !== undefined) target.background = background;
    for (const [key, name] of [["bold", "Bold"], ["italic", "Italic"], ["mono", "Monospace"], ["underline", "Underline"], ["strike", "Strikethrough"]] as const) {
      const value = source[key];
      if (value === undefined || value === null || value === false) continue;
      if (value === true) target[key] = true;
      else errors.push(`${prefix}${name} is true or false.`);
    }
  };
  cellStyle(input, presentation);

  if (input.options !== undefined && input.options !== null) {
    if (!isRecord(input.options)) {
      errors.push("Options must map a value to how it shows.");
    } else {
      const entries = Object.entries(input.options);
      if (entries.length > MAX_OPTIONS) errors.push(`At most ${MAX_OPTIONS} options.`);
      const shown: Record<string, ColumnOptionPresentation> = {};
      for (const [value, raw] of entries.slice(0, MAX_OPTIONS)) {
        if (!isRecord(raw)) {
          errors.push(`How "${value}" shows must be an object.`);
          continue;
        }
        for (const key of Object.keys(raw)) {
          if (key !== "label" && key !== "color" && key !== "icon") errors.push(`Unknown option setting "${key}" on "${value}".`);
        }
        const option: ColumnOptionPresentation = {};
        const optionLabel = text(raw.label, `The label of "${value}"`, MAX_LENGTH.optionLabel);
        if (optionLabel !== undefined) option.label = optionLabel;
        if (raw.color !== undefined && raw.color !== null && raw.color !== "") {
          if ((WIDGET_COLORS as readonly unknown[]).includes(raw.color)) option.color = raw.color as (typeof WIDGET_COLORS)[number];
          else errors.push(`The color of "${value}" is one of: ${WIDGET_COLORS.join(", ")}.`);
        }
        const optionIcon = iconName(raw.icon, `The icon of "${value}"`);
        if (optionIcon !== undefined) option.icon = optionIcon;
        if (Object.keys(option).length > 0) shown[value] = option;
      }
      if (Object.keys(shown).length > 0) presentation.options = shown;
    }
  }

  // Conditions: their shape here; their filters are checked against the grammar by the server (parseFilter).
  if (input.conditions !== undefined && input.conditions !== null) {
    if (!Array.isArray(input.conditions)) {
      errors.push("Conditions must be a list.");
    } else {
      if (input.conditions.length > MAX_CONDITIONS) errors.push(`At most ${MAX_CONDITIONS} conditions.`);
      const names = new Set<string>();
      const conditions: ColumnCondition[] = [];
      for (const [index, raw] of input.conditions.slice(0, MAX_CONDITIONS).entries()) {
        const at = `Condition ${index + 1}: `;
        if (!isRecord(raw)) {
          errors.push(`${at}must be an object.`);
          continue;
        }
        for (const key of Object.keys(raw)) {
          if (!["name", "enabled", "where", "applyTo", "style"].includes(key)) errors.push(`${at}unknown setting "${key}".`);
        }
        const name = text(raw.name, `${at}its name`, MAX_LENGTH.label);
        if (name === undefined) errors.push(`${at}needs a name.`);
        else if (names.has(name.toLowerCase())) errors.push(`${at}"${name}" is used twice.`);
        if (!isRecord(raw.where) || Object.keys(raw.where).length === 0) errors.push(`${at}needs a filter (where).`);
        const applyTo = oneOf(raw.applyTo, CONDITION_APPLY_TO, `${at}Apply to`);
        if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") errors.push(`${at}enabled is true or false.`);
        const style: ConditionStyle = {};
        if (raw.style !== undefined && !isRecord(raw.style)) errors.push(`${at}its style must be an object.`);
        else if (isRecord(raw.style)) {
          cellStyle(raw.style, style, at);
          const conditionIcon = iconName(raw.style.icon, `${at}Icon`);
          if (conditionIcon !== undefined) style.icon = conditionIcon;
          for (const key of ["badge", "dim"] as const) {
            const value = raw.style[key];
            if (value === true) style[key] = true;
            else if (value !== undefined && value !== null && value !== false) errors.push(`${at}${key} is true or false.`);
          }
        }
        if (name === undefined || !isRecord(raw.where)) continue;
        names.add(name.toLowerCase());
        conditions.push({ name, ...(raw.enabled === false && { enabled: false }), where: raw.where, ...(applyTo === "row" && { applyTo }), style });
      }
      if (conditions.length > 0) presentation.conditions = conditions;
    }
  }

  if (input.input !== undefined && input.input !== null && input.input !== "") {
    const inputs = COLUMN_INPUT_KEYS.filter((key) => COLUMN_INPUTS[key].kinds.includes(kind));
    if (typeof input.input === "string" && (inputs as readonly string[]).includes(input.input)) presentation.input = input.input;
    else errors.push(`Input "${String(input.input)}" doesn't edit a ${kind} column - one of: ${inputs.join(", ")}.`);
  }
  return { presentation, errors };
}


/**
 * One column of a table - a page's Table, a Dashboard's TABLE
 * (Specification_DataViews.md §15, "A table's columns,
 * one model"): what it shows of the value and how its cells look, plus
 * whether it's hidden. Only what was changed is stored; in a Table the
 * rest is inherited from the resource's column.
 */
export interface TableColumnSettings extends CellStyle {
  label?: string;
  shortLabel?: string;
  displayFormat?: string;
  emptyText?: string;
  booleanLabels?: { true?: string; false?: string };
  linkType?: (typeof COLUMN_LINK_TYPES)[number];
  options?: Record<string, ColumnOptionPresentation>;
  hidden?: boolean;
  /** A dashboard TABLE's only (D28): its footer's total - computed by PostgreSQL over the whole result. */
  total?: "sum" | "avg" | "min" | "max" | "count";
  /**
   * A page Table's only: its cells' color per row - a formula over the row
   * (`{{campo}}`) and the page (`{{vars.*}}`) giving a palette color, over
   * `color`. Never inherited: it reads the page, it isn't the column's.
   */
  colorFormula?: string;
}

/** What of a column's presentation a table column shows - the rest (help, placeholder, an input's icon) is a form's. */
export const TABLE_COLUMN_PRESENTATION_KEYS = [
  "label",
  "shortLabel",
  "displayFormat",
  "emptyText",
  "booleanLabels",
  "linkType",
  "options",
  "align",
  "fontSize",
  "bold",
  "italic",
  "mono",
  "underline",
  "strike",
  "color",
  "background",
] as const satisfies readonly ColumnPresentationKey[];

/**
 * How a row of a table shows wherever a foreign key points at it
 * (Specification_DataViews.md §15.5) - set once on the table
 * (`resources.row_presentation`), inherited by every foreign-key
 * column that sets none of its own. A template wins over `displayField`.
 */
export interface RowPresentation {
  /** The column shown instead of the key. */
  displayField?: string;
  /** Several columns at once, `{{name}} ({{country}})` - sorted by its first. */
  displayTemplate?: string;
}

/** The columns a display template names, in order: `{{name}} ({{country}})` → name, country. */
export function templateColumns(template: string): string[] {
  return [...template.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)].map((match) => match[1]!);
}

/** A table's row presentation, checked against its real columns; an empty object clears it. */
export function validateRowPresentation(input: unknown, columns: readonly string[]): { presentation: RowPresentation; errors: string[] } {
  const errors: string[] = [];
  const presentation: RowPresentation = {};
  if (!isRecord(input)) return { presentation, errors: ["The row presentation must be an object."] };
  for (const key of Object.keys(input)) {
    if (key !== "displayField" && key !== "displayTemplate") errors.push(`Unknown option "${key}".`);
  }
  const { displayField, displayTemplate } = input;
  if (displayField !== undefined && displayField !== null && displayField !== "") {
    if (typeof displayField !== "string") errors.push("displayField must be text.");
    else if (!columns.includes(displayField)) errors.push(`The table has no column "${displayField}".`);
    else presentation.displayField = displayField;
  }
  if (displayTemplate !== undefined && displayTemplate !== null && displayTemplate !== "") {
    if (typeof displayTemplate !== "string") errors.push("displayTemplate must be text.");
    else {
      const template = displayTemplate.trim();
      const named = templateColumns(template);
      const unknown = named.filter((column) => !columns.includes(column));
      if (named.length === 0) errors.push("displayTemplate names no column - write one as {{column}}.");
      else if (unknown.length > 0) errors.push(`The table has no column ${unknown.map((c) => `"${c}"`).join(", ")}.`);
      else if (template.length > 256) errors.push("displayTemplate is longer than 256 characters.");
      else if (CONTROL_CHARACTERS.test(template)) errors.push("displayTemplate has a control character.");
      else presentation.displayTemplate = template;
    }
  }
  return { presentation, errors };
}

/**
 * A column's title (Specification_DataViews.md §15): its label, else its name humanized - or, where room is short
 * (a list's header, a card's field name: `short`), its short label first. Filters, exports, forms and messages take
 * the label.
 */
export function columnTitle(presentation: Pick<ColumnPresentation, "label" | "shortLabel"> | undefined, fallback: string, options: { short?: boolean } = {}): string {
  return (options.short ? presentation?.shortLabel : undefined) ?? presentation?.label ?? fallback;
}
