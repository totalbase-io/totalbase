/**
 * The UI's texts come in areas - one file per area and language under
 * i18n/locales/<language>/<area>.json, each owning its top-level keys
 * (Admin_UI.md §14). Two kinds:
 *
 * - **eager** areas load with the app, for every visitor: the shell (and
 *   `common`, `errors`, `auth`, `account`) and the DataView runtime - what
 *   an App viewer reads.
 * - **lazy** areas - the editors and the administration - load on the
 *   first visit to a route that needs them (middleware/i18n-areas.global.ts
 *   through plugins/i18n-areas.client.ts), in the language in use, and
 *   follow a language switch. Before this, all nine areas (~450 KB of
 *   JSON per language) loaded at boot for a viewer who needed two.
 *
 * Plain data, no Nuxt imports: nuxt.config.ts reads it to register the
 * eager files with @nuxtjs/i18n, the plugin to know what to load.
 */

export const EAGER_LOCALE_AREAS = ['shell', 'dataviews-runtime'] as const

export const LAZY_LOCALE_AREAS = ['users', 'settings', 'database', 'dataviews-designer', 'dashboards', 'workflows', 'content'] as const

export type LazyLocaleArea = (typeof LAZY_LOCALE_AREAS)[number]

/** Each lazy area's top-level message keys - how a missing key is traced back to the area it lives in. */
export const LAZY_AREA_BY_KEY: Readonly<Record<string, LazyLocaleArea>> = {
  users: 'users',
  settings: 'settings',
  database: 'database',
  designer: 'dataviews-designer',
  dashboards: 'dashboards',
  workflows: 'workflows',
  content: 'content'
}

/**
 * The lazy areas a route needs, by path prefix - the first match wins, so a
 * longer prefix goes before a shorter one. A route's own pages' keys, plus
 * the areas of the shared pieces they draw:
 *
 * - the App (`/app`) and an embed read `database` too: the table pager
 *   and the filter operators keep their texts there (TablePager.vue,
 *   filterOperators.ts) and every grid shows them;
 * - `/settings` reads `users` for the token and link helpers its API
 *   tokens page shares with Users; the DataView, Dashboard and Workflow
 *   editors read it for their object access (roles) tab, and a table's page for
 *   its Create DataView window's roles (QuickDataViewModal.vue).
 *
 * The audit log's grid and entry (AuditLogGrid) keep their texts in the
 * eager `audit` keys - a user's Activity tab and My account show them.
 *
 * A key of an area this map leaves out still resolves: the plugin loads
 * the area the first time such a key is asked for (one paint with the
 * key, then the text) - a safety net, not the plan; add the route here
 * when a page shows the key.
 */
export const LOCALE_AREAS_BY_ROUTE: readonly (readonly [prefix: string, areas: readonly LazyLocaleArea[]])[] = [
  ['/app/dashboards', ['dashboards', 'database']],
  ['/app', ['database']],
  ['/embed', ['dashboards', 'database']],
  ['/users', ['users']],
  ['/roles', ['users']],
  ['/tokens', ['users']],
  ['/sessions', ['users']],
  // Backups' schedule is the workflows' cron editor (CronScheduleFields.vue): its words are the workflows area's.
  ['/settings/backups', ['settings', 'users', 'workflows']],
  ['/settings', ['settings', 'users']],
  ['/database', ['database', 'users']],
  ['/resources', ['database', 'users']],
  ['/sql-console', ['database']],
  ['/dataviews', ['dataviews-designer', 'database', 'dashboards', 'users']],
  ['/dashboards', ['dashboards', 'database', 'users']],
  ['/workflows', ['workflows', 'database', 'users']],
  ['/templates', ['content']],
  ['/docs', ['content', 'database']],
  ['/logs', ['content', 'database']],
  ['/files', ['content', 'database']]
]

/** The lazy areas `path` needs - none for a route the map doesn't name (the sign-in page, My account). */
export function localeAreasForRoute(path: string): readonly LazyLocaleArea[] {
  return LOCALE_AREAS_BY_ROUTE.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`))?.[1] ?? []
}

/** The lazy area a message key belongs to, by its first segment - undefined for an eager area's key or an unknown one. */
export function lazyAreaOfKey(key: string): LazyLocaleArea | undefined {
  return LAZY_AREA_BY_KEY[key.split('.', 1)[0]!]
}
