/**
 * Parses a Grafana-style duration string ("5s", "30s", "1m", "5m", "15m",
 * "1h", ...) into milliseconds - the `?refresh=` URL query param
 * DataViewGrid.vue reads to auto-refresh its rows on an interval, same
 * idea as Grafana's dashboard auto-refresh picker (also URL-driven,
 * shareable/bookmarkable). Returns `null` for anything absent or not a
 * valid `<digits><unit>` string - auto-refresh is simply off then, never
 * a thrown error over a malformed/missing query param.
 */
const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000
}

export function parseRefreshInterval(value: string | string[] | null | undefined): number | null {
  if (typeof value !== 'string') return null
  const match = /^(\d+)(s|m|h)$/.exec(value.trim())
  if (!match) return null
  const amount = Number.parseInt(match[1]!, 10)
  if (amount <= 0) return null
  return amount * UNIT_MS[match[2]!]!
}

/** The interval back into its canonical string form (e.g. `60000` -> `"1m"`) - used for the toolbar's own "Auto-refresh: 1m" indicator, so it always echoes the same unit the URL used rather than reformatting into a different one. */
export function formatRefreshInterval(value: string | string[] | null | undefined): string | null {
  return typeof value === 'string' && parseRefreshInterval(value) !== null ? value.trim() : null
}
