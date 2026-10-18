/**
 * Minimal RFC 4180 CSV parse/stringify - no external dependency exists in
 * the repo (checked before adding one) and the Files operations' needs
 * are narrow: a header row + quoted fields containing commas/quotes/
 * newlines. Not a general-purpose CSV library (no custom delimiters,
 * no streaming) - just enough for Parse file / Generate file.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => !(r.length === 1 && r[0] === ""));
  if (nonEmpty.length === 0) return [];
  const [header, ...dataRows] = nonEmpty;
  return dataRows.map((r) => Object.fromEntries(header!.map((key, i) => [key, r[i] ?? ""])));
}

function csvField(value: unknown): string {
  const str = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export function stringifyCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const header = Object.keys(rows[0]!);
  const lines = [header.map(csvField).join(",")];
  for (const row of rows) lines.push(header.map((key) => csvField(row[key])).join(","));
  return lines.join("\r\n");
}
