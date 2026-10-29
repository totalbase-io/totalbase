import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SETTINGS_GROUP_METADATA, SETTINGS_METADATA } from "../packages/settings/src/metadata";
import {
  COLUMN_INPUTS,
  DASHBOARD_REFRESH_INTERVALS,
  DASHBOARD_WIDGET_CATALOG,
  DASHBOARD_WIDGET_GROUPS,
  OPERATION_CATALOG,
  OPERATION_GROUPS,
  SNIPPET_CATALOG,
  SNIPPET_GROUPS,
  VALUE_TYPE_META,
  VARIABLE_CATALOG,
  WIDGET_CATALOG,
} from "../packages/tb-catalog/src/index";

/**
 * No text left untranslated (Admin_UI.md §14). apps/admin's own test holds every language to English's keys;
 * this one holds English to what the admin asks for:
 *
 * - every key the admin's code names literally - `t('settings.panel.searchSettings')` - exists, and every
 *   key built from a template - `` t(`errors.${code}`) `` - starts with a group that exists: a missing one
 *   paints as its key;
 * - every text of the settings catalog (@totalbase/settings, English, served to the admin) has its key under
 *   `settings.metadata.*`, and every text of @totalbase/tb-catalog's catalogs where the admin looks it up: the
 *   designer's widgets, variables, snippets and value types (`designer.catalog.*`, designer-catalog-text.ts),
 *   the dashboard widgets (`dashboards.catalog.*`, types/dashboard.ts), the workflow operations
 *   (`workflows.catalog.*`, workflow-operations.ts) and the column inputs (`database.columnInputs.*`,
 *   column-input-text.ts): a missing one shows its English in every other language, silently.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN = path.join(ROOT, "apps/admin");

type Messages = { [key: string]: string | Messages };
/** File formats and encodings a picker offers by name - the same in every language. */
const FORMAT_NAMES = ["JPEG", "PNG", "WebP", "AVIF", "CSV", "HTML", "Base64", "Hex", "HMAC", "SHA256", "PKCS"];
const english: Messages = Object.assign(
  {},
  ...readdirSync(path.join(ADMIN, "i18n/locales/en")).map((file) => JSON.parse(readFileSync(path.join(ADMIN, "i18n/locales/en", file), "utf8")) as Messages),
);
/** A message, or a group of them (a plural's or a lookup's parent), at `key`. */
function exists(key: string): boolean {
  let node: string | Messages | undefined = english;
  for (const part of key.split(".")) {
    if (typeof node !== "object") return false;
    node = node[part];
  }
  return node !== undefined;
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(vue|ts)$/.test(name) && !name.endsWith(".test.ts") ? [full] : [];
  });
}

describe("i18n coverage", () => {
  const files = sources(path.join(ADMIN, "app")).map((file) => ({ file: path.relative(ROOT, file), text: readFileSync(file, "utf8") }));

  it("every key the admin names exists in English", () => {
    // t('a.b'), $t('a.b'), i18n.t('a.b'), te/tm - a literal key.
    const literal = /(?<![\w.])(?:\$?t|te|tm|i18n\.t)\(\s*'([a-zA-Z][\w-]*(?:\.[\w-]+)+)'(?!\s*\+)/g;
    // t(`a.b.${x}`) - the fixed part before the first interpolation.
    const built = /(?<![\w.])(?:\$?t|te|tm|i18n\.t)\(\s*`([a-zA-Z][\w-]*(?:\.[\w-]+)*)\.\$\{/g;
    const missing: string[] = [];
    for (const { file, text } of files) {
      for (const [, key] of text.matchAll(literal)) if (!exists(key!)) missing.push(`${file}: ${key}`);
      for (const [, prefix] of text.matchAll(built)) if (!exists(prefix!)) missing.push(`${file}: ${prefix}.*`);
    }
    expect(missing).toEqual([]);
  });

  it("no key is built with +", () => {
    // t('a.b.' + x) can't be checked: a template - t(`a.b.${x}`) - can (its fixed start, above).
    const concatenated = /(?<![\w.])(?:\$?t|te|tm|i18n\.t)\(\s*'[^']*'\s*\+/g;
    const found = files.flatMap(({ file, text }) => [...text.matchAll(concatenated)].map((match) => `${file}: ${match[0]} - use a template: t(\`a.b.\${x}\`)`));
    expect(found).toEqual([]);
  });

  it("no text a script shows is written in place", () => {
    // What a template shows is the lint's (@intlify/vue-i18n/no-raw-text); what a script hands a label, a
    // title, a toast, a notice... is this test's. The same names read the same in every language as the lint allows.
    const config = readFileSync(path.join(ADMIN, "eslint.config.mjs"), "utf8");
    const names = new Set([...config.slice(config.indexOf("ignoreText")).matchAll(/'([^']+)'/g)].flatMap(([, name]) => name!.split(/\s+/)));
    for (const name of FORMAT_NAMES) names.add(name);
    const property = /(?<![\w-])(title|label|description|text|placeholder|header|ariaLabel|'aria-label'|message)\s*:\s*'((?:[^'\\\n]|\\.)*)'/g;
    // The admin's notices take their text as an argument: a page's notify(message), notifyError(error, title,
    // fallback), errorMessage(error, fallback) / apiErrorMessage(i18n, error, fallback), the browser's dialogs.
    const notice = /(?:(?<![\w.])|(?<=\bwindow\.))(notify|notifyError|errorMessage|apiErrorMessage|alert|confirm|prompt)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
    const literalArgument = /'((?:[^'\\\n]|\\.)*)'/g;
    /** A word of a sentence: not a name, not a technical value (ALL CAPS, a style class, a pattern). */
    const isText = (value: string) =>
      value.split(/\s+/).some((token) => {
        if (/[-:/[\]_#$@{}.]/.test(token) || /\d/.test(token)) return false;
        const word = token.replace(/[^A-Za-z]/g, "");
        return word.length >= 3 && word !== word.toUpperCase() && !names.has(word) && !names.has(token);
      });
    const found: string[] = [];
    for (const { file, text } of files) {
      if (!/\/app\/(components|pages|composables|layouts|plugins|middleware)\//.test(file)) continue;
      // A .vue file's template is the lint's; its <script> is this test's.
      const script = file.endsWith(".vue") ? (text.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? "") : text;
      const lines = script.split("\n");
      // `// i18n: <why>` - English the code translates by a key, or a name - covers its own line, the next one,
      // or, above a list or an object, all of it (to the line closing it at the same indentation).
      let closing: string | null = null;
      lines.forEach((line, index) => {
        if (closing !== null) {
          if (line.startsWith(closing)) closing = null;
          return;
        }
        const above = lines[index - 1] ?? "";
        if (/\/\/ i18n:/.test(line)) return;
        if (/^\s*\/\/ i18n:/.test(above)) {
          if (/[[{]\s*$/.test(line)) closing = `${line.match(/^\s*/)![0]}${line.trimEnd().endsWith("[") ? "]" : "}"}`;
          return;
        }
        for (const [, prop, value] of line.matchAll(property)) {
          if (isText(value!)) found.push(`${file}: ${prop}: '${value}'`);
        }
        for (const [, fn, args] of line.matchAll(notice)) {
          // A lowercase word alone is a value the call compares or passes on ('error', 'edit'), not a text.
          for (const [, value] of args!.matchAll(literalArgument)) if (!/^[a-z]+$/.test(value!) && isText(value!)) found.push(`${file}: ${fn}(..., '${value}')`);
        }
      });
    }
    expect(found, "Use a key (t('...')), or mark the line `// i18n: <why>`").toEqual([]);
  });

  it("every text of the settings catalog has its key", () => {
    /** "Accounts & sessions" -> accountsSessions (SettingsGroupForm.vue's own). */
    const sectionKey = (section: string) =>
      section.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase())).join("");
    // Options shown by their own name in every language: the languages, the map tile providers, the regional formats (named by Intl).
    const ownNames = new Set(["system.language", "maps.tiles", "system.regional_format"]);
    const missing: string[] = [];
    const need = (key: string) => {
      if (!exists(`settings.metadata.${key}`)) missing.push(key);
    };
    for (const [group, meta] of Object.entries(SETTINGS_GROUP_METADATA)) {
      need(`groups.${group}.label`);
      if (meta.description) need(`groups.${group}.description`);
    }
    for (const [setting, meta] of Object.entries(SETTINGS_METADATA)) {
      const key = `keys.${setting.replaceAll(".", "__")}`;
      need(`${key}.label`);
      if (meta.description) need(`${key}.description`);
      if (meta.unit) need(`units.${meta.unit}`);
      if (meta.section) need(`sections.${sectionKey(meta.section)}`);
      for (const option of meta.options ?? []) {
        if (!ownNames.has(setting) || option.value === "") need(`${key}.options.${option.value || "empty"}`);
        if (option.description) need(`${key}.optionDescriptions.${option.value}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every text of the designer's catalogs has its key", () => {
    type Entry = { label?: string; description?: string; payload?: string; [key: string]: unknown };
    const missing: string[] = [];
    const need = (key: string) => {
      if (!exists(`designer.catalog.${key}`)) missing.push(key);
    };
    const each = (record: unknown) => Object.entries((record ?? {}) as Record<string, Entry>);
    for (const [widget, def] of each(WIDGET_CATALOG)) {
      need(`widgets.${widget}.label`);
      if (def.description) need(`widgets.${widget}.description`);
      // A prop's text is its widget's own key, else the one every widget shares (designer-catalog-text.ts).
      for (const [prop, meta] of each(def.props)) {
        for (const field of ["label", "description"] as const) {
          if (meta[field] && !exists(`designer.catalog.widgets.${widget}.props.${prop}.${field}`)) need(`sharedProps.${prop}.${field}`);
        }
      }
      for (const [slot] of each(def.slots)) need(`widgets.${widget}.slots.${slot}`);
      for (const [emit] of each(def.emits)) need(`widgets.${widget}.emits.${emit}`);
    }
    for (const [kind, def] of each(VARIABLE_CATALOG)) {
      need(`variables.${kind}.label`);
      if (def.description) need(`variables.${kind}.description`);
      for (const [prop, meta] of each(def.props)) {
        need(`variables.${kind}.props.${prop}.label`);
        if (meta.description) need(`variables.${kind}.props.${prop}.description`);
      }
      for (const [state, meta] of each(def.state)) {
        need(`variables.${kind}.state.${state}.label`);
        if (meta.description) need(`variables.${kind}.state.${state}.description`);
      }
      for (const [method, meta] of each(def.expose)) if (meta.description) need(`variables.${kind}.expose.${method}`);
      for (const [emit] of each(def.emits)) need(`variables.${kind}.emits.${emit}`);
    }
    for (const [snippet, def] of each(SNIPPET_CATALOG)) {
      need(`snippets.${snippet}.label`);
      if (def.description) need(`snippets.${snippet}.description`);
      for (const [param, meta] of each(def.params)) {
        need(`snippets.${snippet}.params.${param}.label`);
        if (meta.description) need(`snippets.${snippet}.params.${param}.description`);
        for (const option of (meta.options ?? []) as { value: string }[]) need(`snippets.${snippet}.params.${param}.options.${option.value}`);
      }
    }
    for (const group of SNIPPET_GROUPS) need(`snippetGroups.${group.key}`);
    for (const [type] of each(VALUE_TYPE_META)) {
      need(`valueTypes.${type}.label`);
      need(`valueTypes.${type}.description`);
    }
    expect(missing).toEqual([]);
  });

  it("every text of the dashboard, workflow and column catalogs has its key", () => {
    type Part = { label?: string; description?: string };
    const missing: string[] = [];
    const need = (key: string) => {
      if (!exists(key)) missing.push(key);
    };
    for (const [type, def] of Object.entries(DASHBOARD_WIDGET_CATALOG) as [string, { description?: string; page?: string; roles: Record<string, Part>; props: Record<string, Part> }][]) {
      // A presentation widget is named as the page designer names its widget, unless it has a name of its own.
      if (!def.page || !exists(`designer.catalog.widgets.${def.page}.label`)) need(`dashboards.catalog.widgets.${type}.label`);
      if (def.description) need(`dashboards.catalog.widgets.${type}.description`);
      // A role's or a prop's text is its widget's own key, else the shared one (useDashboardCatalogText).
      for (const kind of ["roles", "props"] as const) {
        for (const [id, part] of Object.entries(def[kind] ?? {})) {
          for (const field of ["label", "description"] as const) {
            if (part[field] && !exists(`dashboards.catalog.widgets.${type}.${kind}.${id}.${field}`)) need(`dashboards.catalog.${kind}.${id}.${field}`);
          }
        }
      }
    }
    for (const group of Object.keys(DASHBOARD_WIDGET_GROUPS)) need(`dashboards.catalog.groups.${group}`);
    for (const { seconds } of DASHBOARD_REFRESH_INTERVALS) need(`dashboards.catalog.refresh.${seconds}`);
    // The steps the editor offers - the trigger (no group) is named by the editor itself.
    for (const operation of OPERATION_CATALOG.filter((entry) => entry.group !== null)) {
      const key = `workflows.catalog.operations.${operation.type.replace(/^totalbase\./, "")}`;
      need(`${key}.label`);
      if ((operation as Part).description) need(`${key}.description`);
    }
    for (const group of OPERATION_GROUPS) need(`workflows.catalog.groups.${group.key}`);
    for (const [key, input] of Object.entries(COLUMN_INPUTS) as [string, Part][]) {
      need(`database.columnInputs.${key}.label`);
      if (input.description) need(`database.columnInputs.${key}.description`);
    }
    expect(missing).toEqual([]);
  });
});
