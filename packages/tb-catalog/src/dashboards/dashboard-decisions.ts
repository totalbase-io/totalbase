/**
 * Automatic decisions and their reasons (Dashboards.md §5.19, DM3): every choice TotalBase makes on its
 * own about a dashboard - a role's default column, a click that doesn't run in an embed, the dashboard assistant's
 * reading of a table (D27) - says why as one shape: `{code, message, detail?}`.
 *
 * - `code`: fixed, kebab-case, one of DASHBOARD_DECISION_CODES - what a program reads (an agent, the alerts' stage);
 * - `message`: the sentence, in the App's language (`system.language`);
 * - `detail`: what was read - a type (`numeric(12,2)`), a constraint (`CHECK 1..12`), a statistic (`n_distinct 24`),
 *   a column - never translated.
 *
 * One list, beside the widget catalog: the guide's "Reasons" section is generated from it, and a test checks that
 * nothing emits a code that isn't here. Errors keep their own codes (`DASHBOARD_…`).
 */

import { UI_LANGUAGES, type UiLanguage } from "@totalbase/shared";

export type DashboardDecisionLanguage = UiLanguage;

export interface DashboardDecision {
  code: DashboardDecisionCode;
  message: string;
  detail?: string;
}

interface DecisionEntry {
  /** What it means - the guide's line. */
  description: string;
  /** Its sentence per language - `{name}` replaced by the decision's params. */
  message: Record<DashboardDecisionLanguage, string>;
}

/**
 * Every code a decision may carry, by area. `message` takes params by name (`{column}`); `detail` goes beside it.
 * Adding a decision adds its line here first.
 */
export const DASHBOARD_DECISION_CODES = {
  // --- A role's columns (save_widget's and apply_dashboard's run) ---
  "role-config": {
    description: "The role's columns are the ones config.roles names.",
    message: { en: "Chosen in the widget's roles.", es: "Elegida en los roles del widget." },
  },
  "role-first-of-kind": {
    description: "No column chosen: the role took the first column of a kind it accepts, by position - never by name, never a _ column, never one another role holds.",
    message: { en: "The first column of a kind {role} takes.", es: "La primera columna del tipo que toma {role}." },
  },
  "role-all-of-kind": {
    description: "No column chosen: the role took every column of a kind it accepts, by position.",
    message: { en: "Every column of a kind {role} takes.", es: "Todas las columnas del tipo que toma {role}." },
  },

  // --- An embed's clicks (D6) ---
  "click-not-in-embed": {
    description: "A widget's click doesn't run in this embed: an embed runs only a FILTER on a variable its visitor may change, and a URL with inEmbeds.",
    message: { en: "The click of \"{widget}\" doesn't run in this embed.", es: "El clic de \"{widget}\" no se ejecuta en esta inserción." },
  },

  // --- The dashboard assistant (D27) ---
  // Its reading of each column (analysis) - from the type, constraints, origin and pg_stats, never the name.
  "moment-default-now": {
    description: "A required date or timestamp that defaults to now(): the time axis.",
    message: { en: "A required date that defaults to now: the time axis.", es: "Una fecha obligatoria con now() por defecto: el eje de tiempo." },
  },
  "moment-several": {
    description: "Several required dates default to now(): the first by position is the time axis, the others its alternatives.",
    message: { en: "Several dates default to now: the first by position is the time axis, the others are alternatives.", es: "Varias fechas tienen now() por defecto: la primera por posición es el eje de tiempo y las otras quedan como alternativas." },
  },
  "moment-alternative": {
    description: "Another candidate time axis, not chosen (it comes later by position).",
    message: { en: "Another possible time axis - \"{moment}\" was chosen.", es: "Otro eje de tiempo posible: se eligió \"{moment}\"." },
  },
  "moment-not-null": {
    description: "No date defaults to now(): the first required date or timestamp is the time axis.",
    message: { en: "No date defaults to now: the first required date is the time axis.", es: "Ninguna fecha tiene now() por defecto: el eje de tiempo es la primera fecha obligatoria." },
  },
  "date-other": {
    description: "A date that may be empty, or isn't a candidate time axis: left out.",
    message: { en: "A date that may be empty: not the time axis, left out.", es: "Una fecha que puede quedar vacía: no es el eje de tiempo, se descarta." },
  },
  "deadline-future-default": {
    description: "A date whose default is in the future (CURRENT_DATE + 30): a deadline, never an axis.",
    message: { en: "A date that defaults to the future: a deadline, not an axis.", es: "Una fecha con valor por defecto en el futuro: un plazo, no un eje." },
  },
  "measure-numeric": {
    description: "A numeric, real or double precision column that is no key and no foreign key: a measure, added up.",
    message: { en: "A decimal number that isn't a key: a measure, added up.", es: "Un número decimal que no es clave: una medida, se suma." },
  },
  "measure-integer-many": {
    description: "A whole number with more than 31 distinct values in pg_stats: a measure, averaged.",
    message: { en: "A whole number with many distinct values: a measure, averaged.", es: "Un número entero con muchos valores distintos: una medida, se promedia." },
  },
  "no-stats": {
    description: "A whole number without pg_stats (a new column, a virtual generated one): taken as a measure until ANALYZE says otherwise.",
    message: { en: "\"{column}\" has no statistics yet: taken as a measure - run ANALYZE and analyze again.", es: "\"{column}\" todavía no tiene estadísticas: se toma como medida; ejecuta ANALYZE y vuelve a analizar." },
  },
  "category-check-list": {
    description: "A CHECK lists the column's values: a category, with their labels and colors.",
    message: { en: "A CHECK lists its values: a category.", es: "Un CHECK enumera sus valores: una categoría." },
  },
  "category-enum": {
    description: "An enum type: a category.",
    message: { en: "An enum type: a category.", es: "Un tipo ENUM: una categoría." },
  },
  "category-domain": {
    description: "A domain whose CHECK lists its values: a category.",
    message: { en: "A domain that lists its values: a category.", es: "Un dominio que enumera sus valores: una categoría." },
  },
  "category-boolean": {
    description: "A boolean: a category (yes or no).",
    message: { en: "Yes or no: a category.", es: "Sí o no: una categoría." },
  },
  "category-check-range": {
    description: "A whole number in a CHECK range of up to 31 values (an hour, a weekday): a category.",
    message: { en: "A whole number in a CHECK range of up to 31 values: a category.", es: "Un entero en un rango de CHECK de hasta 31 valores: una categoría." },
  },
  "category-few-values": {
    description: "A whole number with 2 to 31 distinct values in pg_stats: a category.",
    message: { en: "A whole number with 2 to 31 distinct values: a category.", es: "Un entero con 2 a 31 valores distintos: una categoría." },
  },
  "dimension-foreign-key": {
    description: "A foreign key: a dimension, shown by its target's row presentation.",
    message: { en: "A foreign key: a dimension, shown by its target's row presentation.", es: "Una clave foránea: una dimensión, mostrada con la presentación de fila de su destino." },
  },
  "dimension-suggested-presentation": {
    description: "A foreign key whose target has no row presentation: shown by the one suggest_presentation proposes (its first unique, required text) - set it.",
    message: { en: "\"{column}\" points at {target}, which has no row presentation: it shows by the one suggest_presentation proposes - set it with set_row_presentation.", es: "\"{column}\" apunta a {target}, que no tiene presentación de fila: se muestra con la que propone suggest_presentation; fíjala con set_row_presentation." },
  },
  "identifier-primary-key": {
    description: "The primary key: an identifier, left out of the charts.",
    message: { en: "The primary key: an identifier, left out.", es: "La clave primaria: un identificador, se descarta." },
  },
  "identifier-unique": {
    description: "A single-column UNIQUE: an identifier, left out of the charts.",
    message: { en: "Unique: an identifier, left out.", es: "Única: un identificador, se descarta." },
  },
  "identifier-sequence": {
    description: "Filled by a sequence or an identity: an identifier, left out of the charts.",
    message: { en: "Filled by a sequence: an identifier, left out.", es: "La llena una secuencia: un identificador, se descarta." },
  },
  "identifier-free-text": {
    description: "Text without a CHECK and with many distinct values: an identifier (a name, a code), left out of the charts.",
    message: { en: "Text without a CHECK and with many values: an identifier, left out.", es: "Texto sin CHECK y con muchos valores: un identificador, se descarta." },
  },
  "single-value": {
    description: "pg_stats shows a single value, or only NULL: left out.",
    message: { en: "\"{column}\" has a single value or is always empty: left out.", es: "\"{column}\" tiene un solo valor o siempre está vacía: se descarta." },
  },
  "uuid-without-fk": {
    description: "A uuid without a foreign key: not a dimension - if it points at a table, add the foreign key and analyze again.",
    message: { en: "\"{column}\" is a uuid without a foreign key: if it points at a table, add the foreign key and analyze again.", es: "\"{column}\" es un uuid sin clave foránea: si apunta a una tabla, agrégale la FK y vuelve a analizar." },
  },
  "text-without-check": {
    description: "Text without a CHECK and with few or unknown values: never a category - if it's a closed list, add the CHECK and analyze again.",
    message: { en: "\"{column}\" is text without a CHECK: if it's a closed list, add the CHECK and analyze again.", es: "\"{column}\" es texto sin CHECK: si es una lista cerrada, agrégale el CHECK y vuelve a analizar." },
  },
  "place-point": {
    description: "A point: a place on a map.",
    message: { en: "A point: a place on the map.", es: "Un punto: un lugar en el mapa." },
  },
  "file-reference": {
    description: "A foreign key to files: a file, shown as its thumbnail.",
    message: { en: "A foreign key to files: a file.", es: "Una clave foránea a files: un archivo." },
  },
  "type-not-analyzed": {
    description: "A type the assistant doesn't chart (json, an array, bytea, a time of day...): left out.",
    message: { en: "A type the assistant doesn't chart: left out.", es: "Un tipo que el asistente no grafica: se descarta." },
  },
  "view-computed": {
    description: "A view's column that is an expression, not a table's column: a measure if it is a number, else left out.",
    message: { en: "A computed column of the view: a measure if it's a number, else left out.", es: "Una columna calculada de la vista: una medida si es un número; si no, se descarta." },
  },
  "no-moment": {
    description: "No date column the analysis can take as the time axis: no trend and no period.",
    message: { en: "No date column: no trend and no period.", es: "No hay columnas de fecha: sin tendencia ni período." },
  },
  // Its proposal (spec, more) - one per widget and variable.
  "kpi-count": {
    description: "A KPI: how many records in the period, with its change against the previous period (prev_from / prev_to).",
    message: { en: "How many records in the period, against the previous period.", es: "Cuántos registros hay en el período, contra el período anterior." },
  },
  "kpi-count-all": {
    description: "A KPI: how many records (no time axis, so no period to compare).",
    message: { en: "How many records there are.", es: "Cuántos registros hay." },
  },
  "kpi-share": {
    description: "A KPI: the percent of records where a boolean is true.",
    message: { en: "The percent of records where \"{column}\" is yes.", es: "El porcentaje de registros con \"{column}\" en sí." },
  },
  "kpi-sum": {
    description: "A KPI: a decimal measure's sum.",
    message: { en: "The sum of \"{column}\".", es: "La suma de \"{column}\"." },
  },
  "kpi-average": {
    description: "A KPI: a whole-number measure's average.",
    message: { en: "The average of \"{column}\".", es: "El promedio de \"{column}\"." },
  },
  "kpi-limit": {
    description: "At most 4 KPIs are ticked, by position - the rest are offered in more.",
    message: { en: "At most 4 KPIs are ticked, by position: this one is offered unticked.", es: "Se marcan hasta 4 indicadores, por posición: este se ofrece sin marcar." },
  },
  trend: {
    description: "A line of records per day, week or month by the period's length - computed in the SQL, in the viewer's time zone.",
    message: { en: "Records per day, week or month by the period's length, in the viewer's time zone.", es: "Registros por día, semana o mes según el largo del período, en la zona horaria de quien mira." },
  },
  "trend-measure": {
    description: "A line of a measure per day, week or month by the period's length.",
    message: { en: "\"{column}\" per day, week or month by the period's length.", es: "\"{column}\" por día, semana o mes según el largo del período." },
  },
  "heatmap-weekday-hour": {
    description: "The time axis has a time of day: a heatmap of weekday by hour.",
    message: { en: "The time axis has a time of day: records by weekday and hour.", es: "El eje de tiempo tiene hora: registros por día de la semana y hora." },
  },
  calendar: {
    description: "A calendar of records per day - for long periods, offered unticked.",
    message: { en: "Records per day of the year, for long periods.", es: "Registros por día del año, para períodos largos." },
  },
  "donut-category": {
    description: "A category of up to 7 values: a donut, with the labels and colors of its values.",
    message: { en: "\"{column}\" has up to 7 values: their share, with each value's label and color.", es: "\"{column}\" tiene hasta 7 valores: su proporción, con la etiqueta y el color de cada valor." },
  },
  ranking: {
    description: "A dimension: its 10 values with the most records, by its target's row presentation.",
    message: { en: "The 10 values of \"{column}\" with the most records.", es: "Los 10 valores de \"{column}\" con más registros." },
  },
  "map-place": {
    description: "A place: the records on a map.",
    message: { en: "The records on the map, by \"{column}\".", es: "Los registros en el mapa, por \"{column}\"." },
  },
  "table-latest": {
    description: "A table of the latest 20 records - a file column as its thumbnail.",
    message: { en: "The latest 20 records.", es: "Los últimos 20 registros." },
  },
  "variable-period": {
    description: "A DATE_RANGE over the time axis, the last 30 days by default.",
    message: { en: "A period over the time axis, the last 30 days by default.", es: "Un período sobre el eje de tiempo; por defecto, los últimos 30 días." },
  },
  "variable-list": {
    description: "A dimension whose target has up to 50 rows (pg_class.reltuples): a list from that table to filter by.",
    message: { en: "\"{column}\" points at a table with few rows: a list to filter by.", es: "\"{column}\" apunta a una tabla con pocas filas: una lista para filtrar." },
  },
  "variable-list-skipped": {
    description: "A dimension whose target has more than 50 rows, or no statistics or resource: no list.",
    message: { en: "\"{column}\" points at a table with many rows (or not yet analyzed): no list to filter by.", es: "\"{column}\" apunta a una tabla con muchas filas (o sin analizar): sin lista para filtrar." },
  },
  "variable-chained": {
    description: "A list whose target has a foreign key to another list's target: chained to it (options.filters).",
    message: { en: "Chained to \"{parent}\": it offers only the values of the one chosen there.", es: "Encadenada a \"{parent}\": ofrece solo los valores del elegido allí." },
  },
  "security-all-rows": {
    description: "A dashboard's queries run with its authority, not the viewer's: it shows every row to whoever may see it.",
    message: { en: "The dashboard shows every row of {table} to whoever may see it - its queries don't apply the viewer's permissions.", es: "El tablero muestra todas las filas de {table} a quien pueda verlo: sus consultas no aplican los permisos de quien mira." },
  },
  "security-open-on-viewer": {
    description: "users has a foreign key to a dimension's target: the list may open on the viewer's own value ($USER), and be changed.",
    message: { en: "Open on the viewer's own: the \"{column}\" list starts at $USER.{field}, and can be changed.", es: "Abrir en lo de quien mira: la lista \"{column}\" empieza en $USER.{field} y se puede cambiar." },
  },
  "security-only-viewer": {
    description: "users has a foreign key to a dimension's target: every query may keep only the viewer's own rows ($USER) - a viewer without one sees every row.",
    message: { en: "Only the viewer's own: every query keeps the rows whose \"{column}\" is $USER.{field} - whoever has no {field} sees every row.", es: "Solo lo de quien mira: cada consulta se queda con las filas cuyo \"{column}\" es $USER.{field}; quien no tiene {field} ve todas." },
  },
} as const satisfies Record<string, DecisionEntry>;

export type DashboardDecisionCode = keyof typeof DASHBOARD_DECISION_CODES;

export function isDashboardDecisionCode(value: string): value is DashboardDecisionCode {
  return Object.prototype.hasOwnProperty.call(DASHBOARD_DECISION_CODES, value);
}

/** A language TotalBase speaks, else English. */
export function decisionLanguage(value: unknown): DashboardDecisionLanguage {
  return UI_LANGUAGES.some((l) => l.code === value) ? (value as DashboardDecisionLanguage) : "en";
}

/** A decision with its sentence in `language`: `{name}` in the message replaced by `params.name`. */
export function dashboardDecision(code: DashboardDecisionCode, language: DashboardDecisionLanguage, params: Record<string, string | number> = {}, detail?: string): DashboardDecision {
  const entry: DecisionEntry = DASHBOARD_DECISION_CODES[code];
  const template = entry.message[language] ?? entry.message.en;
  const message = template.replace(/\{(\w+)\}/g, (whole, name: string) => (params[name] !== undefined ? String(params[name]) : whole));
  return { code, message, ...(detail !== undefined && detail !== "" ? { detail } : {}) };
}

/**
 * A role's name in a language other than the catalog's English (DB42) - what a decision's message names it by; the
 * admin's own translations say the same.
 */
const ROLE_LABELS: Partial<Record<DashboardDecisionLanguage, Record<string, string>>> = {
  es: {
    category: "Categoría", values: "Valores", series: "Serie", label: "Etiqueta", value: "Valor", compare: "Comparación",
    time: "Tiempo", target: "Meta", location: "Ubicación", latitude: "Latitud", longitude: "Longitud", size: "Tamaño",
    columns: "Columnas", tooltip: "Tooltip", total: "Total", levels: "Niveles", x: "X", y: "Y", group: "Grupo",
    date: "Fecha", image: "Imagen", rows: "Filas",
  },
};

/** A role's label in `language` - the catalog's (English) when there's no translation for it. */
export function dashboardRoleLabel(role: string, english: string, language: DashboardDecisionLanguage): string {
  return ROLE_LABELS[language]?.[role] ?? english;
}
