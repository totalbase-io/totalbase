/**
 * A SETTINGS DataView's columns (`view_config.settings_layout`, DataViews.md §5.12) and the
 * names a parameter table's columns usually go by - so the admin's wizard and the MCP can tell a settings
 * table and propose its layout. English and Spanish names.
 */
export interface SettingsLayout {
  keyColumn: string | null;
  valueColumn: string | null;
  titleColumn: string | null;
  descriptionColumn: string | null;
  groupColumn: string | null;
  orderColumn: string | null;
}
export const SETTINGS_LAYOUT_KEYS = ["keyColumn", "valueColumn", "titleColumn", "descriptionColumn", "groupColumn", "orderColumn"] as const;
export const REQUIRED_SETTINGS_LAYOUT_KEYS = ["keyColumn", "valueColumn", "titleColumn", "descriptionColumn"] as const;

const SETTINGS_COLUMN_NAMES: Record<keyof SettingsLayout, string[]> = {
  keyColumn: ["key", "clave", "code", "codigo", "name", "nombre", "setting", "parametro", "parameter"],
  valueColumn: ["value", "valor"],
  titleColumn: ["title", "titulo", "label", "etiqueta"],
  descriptionColumn: ["description", "descripcion", "help", "ayuda"],
  groupColumn: ["group", "grupo", "section", "seccion", "category", "categoria"],
  orderColumn: ["order", "orden", "position", "posicion", "sort", "sort_order"],
};

/** The layout its column names suggest - each slot the first column named like it. */
export function suggestSettingsLayout(columns: readonly string[]): SettingsLayout {
  const used = new Set<string>();
  const find = (key: keyof SettingsLayout): string | null => {
    for (const name of SETTINGS_COLUMN_NAMES[key]) {
      const hit = columns.find((c) => c.toLowerCase() === name && !used.has(c));
      if (hit) {
        used.add(hit);
        return hit;
      }
    }
    return null;
  };
  // The value first: "name" could be a key or a title, never the value.
  const valueColumn = find("valueColumn");
  const keyColumn = find("keyColumn");
  return { keyColumn, valueColumn, titleColumn: find("titleColumn"), descriptionColumn: find("descriptionColumn"), groupColumn: find("groupColumn"), orderColumn: find("orderColumn") };
}

/** A table shaped like parameters - a key and a value at least, by name. */
export function looksLikeSettingsTable(columns: readonly string[]): boolean {
  const layout = suggestSettingsLayout(columns);
  return Boolean(layout.keyColumn && layout.valueColumn);
}
