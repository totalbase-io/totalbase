import type { LocationQuery } from 'vue-router'
import { DASHBOARD_REFRESH_INTERVALS } from '@totalbase/tb-catalog'
import { isUiLanguage } from '@totalbase/shared'

/**
 * A dashboard embed's URL parameters (Dashboards.md §9.5), over
 * what the embed itself was set up with in the drawer - presentation and
 * starting state only - the visitor can edit the URL, so
 * nothing here restricts data (that is the signed token's `params`). An
 * unknown or malformed value is ignored, never an error: the embed still
 * shows, as it would without it.
 */
export interface EmbedParams {
  /** `theme=light|dark|auto` - unset: the visitor's system preference. */
  theme: 'light' | 'dark' | 'system' | null
  /** `background=false` - transparent, the embedding page shows through; `true` - opaque; unset - the embed's own setting. */
  transparent: boolean | undefined
  /** `titled=true|false` - the dashboard's name and description above it; unset - the embed's own setting. */
  titled: boolean | undefined
  /** `hide=variables` - no variables bar at all. */
  hideBar: boolean
  /** `hide=region,periodo` - these variables left out of the bar (they keep their default or `var-` value). */
  hiddenVariables: string[]
  /** `refresh=30s|1m|5m|15m|1h|off` - undefined: the dashboard's own interval; null: off. */
  refreshSeconds: number | null | undefined
  /** `locale=es` - the embed's UI language (Admin_UI.md §14); unset - the instance's. One of UI_LANGUAGES, else ignored. */
  locale: string | undefined
  /** `var-<name>=value` - starting values, as the App's URL writes them (`from..to`, repeated keys); the bar can change them. */
  variables: LocationQuery
}

const REFRESH: Record<string, number | null> = {
  off: null,
  ...Object.fromEntries(DASHBOARD_REFRESH_INTERVALS.map(i => [i.seconds % 3600 === 0 ? `${i.seconds / 3600}h` : i.seconds % 60 === 0 ? `${i.seconds / 60}m` : `${i.seconds}s`, i.seconds]))
}

function text(raw: LocationQuery[string] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value.trim() : null
}

/** `on` -> true, `off` -> false, anything else -> undefined (unset). */
function flag(value: string | null, on: string, off: string): boolean | undefined {
  return value === on ? true : value === off ? false : undefined
}

export function parseEmbedParams(query: LocationQuery): EmbedParams {
  const theme = text(query.theme)
  const hide = (text(query.hide) ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const refresh = text(query.refresh)
  const variables: LocationQuery = {}
  for (const [key, value] of Object.entries(query)) {
    if (key.startsWith('var-') && key.length > 4) variables[key.slice(4)] = value
  }
  return {
    theme: theme === 'light' || theme === 'dark' ? theme : theme === 'auto' ? 'system' : null,
    transparent: flag(text(query.background), 'false', 'true'),
    titled: flag(text(query.titled), 'true', 'false'),
    hideBar: hide.includes('variables'),
    hiddenVariables: hide.filter(name => name !== 'variables'),
    refreshSeconds: refresh !== null && refresh in REFRESH ? REFRESH[refresh] : undefined,
    locale: isUiLanguage(text(query.locale)) ? text(query.locale)! : undefined,
    variables
  }
}
