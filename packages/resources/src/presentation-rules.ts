import {
  checkConstraintPatterns,
  checkConstraintValues,
  columnPresentationOptions,
  columnValueKind,
  type ColumnPresentation,
  type ForeignKeyTarget,
  type RowPresentation,
} from "@totalbase/tb-catalog";
import type { RelationDetail } from "@totalbase/pg-catalog";

/**
 * Suggest presentation (Specification_DataViews.md §15.6, T69): what a column's type and constraints - never its
 * name, never a language - say about how it should show, beyond what TotalBase already does by default (numbers
 * right-aligned with the locale's grouping and their column's scale, dates in the instance's patterns, a column's
 * name humanized as its label): storing those would only freeze a default. A suggestion is a help - it fills or
 * changes a column's own presentation, and keeps no state of its own.
 */

/** Why a value is suggested - a code the UI words in the viewer's language. */
export type SuggestionReason =
  | "unique-integer" // a whole number that is a key: an identifier, no thousands separator
  | "nullable" // may be empty: shown as —
  | "check-pattern" // a CHECK's regular expression: an example that matches it
  | "check-pattern-code" // a CHECK's pattern of digits and separators: monospaced
  | "email-pattern" // a CHECK's pattern for an email address
  | "url-pattern" // a CHECK's pattern for a URL
  | "check-list" // a CHECK IN list: each value's label, mechanically from the value
  | "comment"; // COMMENT ON COLUMN

export interface PresentationSuggestion {
  key: keyof ColumnPresentation;
  value: unknown;
  reason: SuggestionReason;
  /** The column has a value of its own for this key - a change, never ticked by default. */
  replaces: boolean;
  /** What the reason read on the column: its type (`numeric(12,2)`), its CHECK range (`CHECK 1..12`). */
  detail?: string;
}

export interface ColumnSuggestions {
  columnName: string;
  dataType: string;
  presentation: ColumnPresentation;
  suggestions: PresentationSuggestion[];
}

export interface RowSuggestion {
  displayField: string;
  reason: "unique-text";
}

export interface RulesInput {
  detail: RelationDetail;
  /** Each column's COMMENT, by name. */
  comments: Record<string, string>;
  /** Each column's own presentation, by name. */
  current: Record<string, ColumnPresentation>;
  /** A view's columns that are a table's column - they show its presentation, so nothing is suggested for them. */
  inherited: ReadonlySet<string>;
  /** The resource's row presentation. */
  row: RowPresentation | null;
  isView: boolean;
}

const INTEGER = /^(smallint|integer|bigint)$/;
const TEXT = /^(text|character varying|character|citext)(\(|$)/;
const EMPTY_TEXT = "—";
const DESCRIPTION_MAX = 256;

/** A value as its label - `RESPONSABLE_INSCRIPTO` → "Responsable Inscripto": words by `_`, each capitalized. */
export function mechanicalLabel(value: string): string {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toLocaleUpperCase() + word.slice(1).toLocaleLowerCase())
    .join(" ");
}

/**
 * An example a regular expression of digits, separators and literal characters accepts (`^\d{2}-\d{8}-\d$` →
 * `12-34567890-1`) - null for anything richer: an example that may not match is worse than none.
 */
export function patternExample(source: string): string | null {
  const body = source.replace(/^\^/, "").replace(/\$$/, "");
  let out = "";
  let digit = 1;
  const nextDigits = (count: number) => {
    let text = "";
    for (let i = 0; i < count; i += 1) {
      text += String(digit % 10);
      digit += 1;
    }
    return text;
  };
  for (let i = 0; i < body.length; ) {
    const rest = body.slice(i);
    const digits = /^(?:\\d|\[0-9\])(?:\{(\d+)\})?/.exec(rest);
    if (digits) {
      const count = digits[1] ? Number(digits[1]) : 1;
      if (count > 30) return null;
      out += nextDigits(count);
      i += digits[0].length;
      continue;
    }
    const escaped = /^\\([-./ ])/.exec(rest);
    if (escaped) {
      out += escaped[1];
      i += 2;
      continue;
    }
    if (/^[-./ A-Za-z0-9]/.test(rest)) {
      out += rest[0];
      i += 1;
      continue;
    }
    return null;
  }
  return out.length > 0 && out.length <= 64 ? out : null;
}

const EMAIL_PATTERN = /@/;
const URL_PATTERN = /^\^?https?|\^\(?https?/i;
/** A pattern of digits and separators only - a code (a tax id, a phone number). */
const CODE_PATTERN = /^\^?(?:\\d|\[0-9\]|\{\d+(?:,\d*)?\}|\\[-./ ]|[-./ ])+\$?$/;

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Every column's suggestions, the ones with none left out; and the row presentation when the resource has none. */
export function suggestPresentation(input: RulesInput): { columns: ColumnSuggestions[]; row: RowSuggestion | null } {
  const { detail } = input;
  const relationBy = new Map(detail.relations.map((relation) => [relation.sourceColumn, relation]));
  const checks = detail.checkConstraints.map((check) => ({ expression: check.expression, message: check.message }));
  const expressions = checks.map((check) => check.expression);
  const uniqueSingle = new Set(detail.uniqueConstraints.filter((set) => set.length === 1).map((set) => set[0]!));
  if (detail.primaryKey.length === 1) uniqueSingle.add(detail.primaryKey[0]!);

  const columns: ColumnSuggestions[] = [];
  for (const column of detail.columns) {
    if (input.inherited.has(column.name)) continue;
    const relation = relationBy.get(column.name);
    const foreignKey: ForeignKeyTarget | null = relation ? { targetSchema: relation.targetSchema, targetTable: relation.targetTable } : null;
    const kind = columnValueKind(column.dataType, foreignKey);
    const takes = columnPresentationOptions(kind);
    const current = input.current[column.name] ?? {};
    const suggestions: PresentationSuggestion[] = [];
    const suggest = (key: keyof ColumnPresentation, value: unknown, reason: SuggestionReason, detail?: string) => {
      if (suggestions.some((s) => s.key === key)) return;
      if (current[key] !== undefined && sameValue(current[key], value)) return;
      suggestions.push({ key, value, reason, replaces: current[key] !== undefined, ...(detail && { detail }) });
    };

    // A column's input is never suggested: Automatic already gives the rule's (§15.2) - storing it would only freeze it.

    // A whole number that is a key reads as a code: invoice 3000, never 3.000.
    if (INTEGER.test(column.dataType) && uniqueSingle.has(column.name) && !relation) suggest("mono", true, "unique-integer");

    if (!input.isView && TEXT.test(column.dataType) && !relation) {
      for (const pattern of checkConstraintPatterns(column.name, checks)) {
        if (EMAIL_PATTERN.test(pattern.source)) {
          suggest("linkType", "email", "email-pattern");
          suggest("icon", "i-lucide-mail", "email-pattern");
        } else if (URL_PATTERN.test(pattern.source)) {
          suggest("linkType", "url", "url-pattern");
          suggest("icon", "i-lucide-link", "url-pattern");
        } else {
          const example = patternExample(pattern.source);
          if (example && takes.placeholder) suggest("placeholder", example, "check-pattern");
          if (CODE_PATTERN.test(pattern.source)) suggest("mono", true, "check-pattern-code");
        }
      }
    }

    // A CHECK list's values, each labelled from the value itself - its color is the author's to choose.
    const values = input.isView ? null : checkConstraintValues(column.name, expressions);
    if (values?.length) {
      const options = { ...(current.options ?? {}) };
      let added = false;
      for (const value of values) {
        if (options[value]?.label) continue;
        options[value] = { ...(options[value] ?? {}), label: mechanicalLabel(value) };
        added = true;
      }
      if (added) suggestions.push({ key: "options", value: options, reason: "check-list", replaces: false });
    }

    const comment = input.comments[column.name]?.trim();
    if (comment && comment.length <= DESCRIPTION_MAX) suggest("description", comment, "comment");

    if (column.nullable && kind !== "boolean" && !column.isGenerated && !detail.primaryKey.includes(column.name)) suggest("emptyText", EMPTY_TEXT, "nullable");

    if (suggestions.length > 0) columns.push({ columnName: column.name, dataType: column.dataType, presentation: current, suggestions });
  }

  // How a row shows where a foreign key points at it: its first text column that is UNIQUE and NOT NULL.
  let row: RowSuggestion | null = null;
  if (!input.isView && !input.row?.displayField && !input.row?.displayTemplate) {
    const candidate = detail.columns.find((c) => TEXT.test(c.dataType) && !c.nullable && uniqueSingle.has(c.name));
    if (candidate) row = { displayField: candidate.name, reason: "unique-text" };
  }
  return { columns, row };
}
