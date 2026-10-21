import type { NavigationMenuItem } from '@nuxt/ui'

/**
 * Reconciled navigation tree - rail-and-panel layout (see layouts/
 * default.vue): a collapsed icon rail picks a group, a fixed second
 * column shows that group's panel. adminNavGroups is the single source
 * of truth - the rail, the mobile slideover, and the command palette
 * (Cmd/Ctrl+K, which flattens every group's `sections` into one
 * searchable list) all read from it. The second column itself is a plain
 * `sections`-driven `UNavigationMenu` for every group except Database,
 * which gets a custom tree component instead (layouts/default.vue
 * special-cases that one key) - see Database's own doc comment below.
 */
export interface AdminNavGroup {
  key: string
  /** An i18n key in adminNavGroups; the text once translateNavGroups() has run. */
  label: string
  icon: string
  /**
   * Dashboard: a bare link with no second-column panel at all. Database:
   * still gets a panel (a tree, not `sections`) - `to` only stands in for
   * `firstRouteInGroup()`/the rail click's default destination, same as it
   * always has, since this group has no `sections` to pull a first link
   * from anymore.
   */
  to?: string
  /** Path prefixes that count as "inside this group", for rail highlighting. */
  routePrefixes?: string[]
  /**
   * Sections shown in the group's second column - a label item starts a
   * subgroup. Every group with sections always has at least one (even a
   * single one, like Integrations' "Automation"), so no panel ever reads
   * as items dropped straight under the group title with no subheading -
   * consistent whether a panel ends up with one subgroup or several.
   * Database has none of these - its panel is DatabaseTree.vue instead.
   */
  sections?: NavigationMenuItem[][]
}

export const adminNavGroups: AdminNavGroup[] = [
  {
    key: 'status',
    label: 'shell.nav.groups.status',
    // The instance's state - where an administrator lands
    // (portalHomeFor); an APP user never sees it.
    icon: 'i-lucide-activity',
    to: '/status',
    routePrefixes: ['/status']
  },
  {
    key: 'app',
    label: 'shell.nav.groups.app',
    icon: 'i-lucide-app-window',
    // Published DataViews and Dashboards in the administrator-arranged
    // menu (Security.md §8) - its panel is AppMenuPanel.vue.
    // First for an APP user: the App is what they work in.
    to: '/app',
    routePrefixes: ['/app']
  },
  {
    key: 'database',
    label: 'shell.nav.groups.database',
    icon: 'i-lucide-database',
    to: '/resources',
    routePrefixes: ['/resources']
  },
  {
    key: 'console',
    label: 'shell.nav.groups.console',
    icon: 'i-lucide-square-terminal',
    routePrefixes: ['/sql-console'],
    sections: [[{ label: 'shell.nav.items.sqlConsole', icon: 'i-lucide-terminal', to: '/sql-console' }]]
  },
  {
    key: 'dataviews',
    label: 'shell.nav.groups.dataviews',
    icon: 'i-lucide-layout-panel-left',
    // No `sections` - gets a custom tree instead (DataViewsTree.vue,
    // grouped by layout type), same special-case Database gets in
    // layouts/default.vue's aside. `to` stands in for the rail click's
    // default destination/mobile nav link, same role it plays for
    // Database's own `to: '/resources'`.
    to: '/dataviews',
    routePrefixes: ['/dataviews']
  },
  {
    key: 'dashboards',
    label: 'shell.nav.groups.dashboards',
    icon: 'i-lucide-layout-dashboard',
    // No `sections` - gets a custom tree instead (DashboardsTree.vue),
    // same special-case DataViews/Workflows get in layouts/default.vue's
    // aside. `to` stands in for the rail click's default destination.
    to: '/dashboards',
    routePrefixes: ['/dashboards']
  },
  {
    key: 'workflows',
    label: 'shell.nav.groups.workflows',
    icon: 'i-lucide-workflow',
    routePrefixes: ['/workflows'],
    sections: [[{ label: 'shell.nav.items.workflows', icon: 'i-lucide-workflow', to: '/workflows' }]]
  },
  {
    key: 'files',
    label: 'shell.nav.groups.files',
    icon: 'i-lucide-folder-open',
    to: '/files',
    routePrefixes: ['/files']
  },
  {
    key: 'templates',
    label: 'shell.nav.groups.templates',
    icon: 'i-lucide-file-text',
    routePrefixes: ['/templates'],
    sections: [[{ label: 'shell.nav.items.templates', icon: 'i-lucide-file-text', to: '/templates' }]]
  },
  {
    // Users and Roles are separate rail groups (not one "Security" group)
    // - the two most-used access screens stay one click away. Users' panel
    // is UsersPanel.vue (filters for the table, not a list of every user -
    // a user list can grow to thousands); `sections` still lists its
    // pages so the mobile nav and the command palette reach the global
    // Tokens/Sessions views too. Tokens and sessions belong to a user, so
    // they live here rather than in a rail group of their own.
    key: 'users',
    label: 'shell.nav.groups.users',
    icon: 'i-lucide-users',
    routePrefixes: ['/users', '/tokens', '/sessions'],
    sections: [[
      { label: 'shell.nav.items.users', icon: 'i-lucide-users', to: '/users' },
      { label: 'shell.nav.items.apiTokens', icon: 'i-lucide-key-round', to: '/tokens' },
      { label: 'shell.nav.items.sessions', icon: 'i-lucide-monitor-smartphone', to: '/sessions' }
    ]]
  },
  {
    // Panel is RolesTree.vue (every role, one click to its editor page) -
    // same split TemplatesTree.vue/pages/templates use.
    key: 'roles',
    label: 'shell.nav.groups.roles',
    icon: 'i-lucide-shield',
    routePrefixes: ['/roles'],
    sections: [[{ label: 'shell.nav.items.roles', icon: 'i-lucide-shield', to: '/roles' }]]
  },
  {
    key: 'logs',
    label: 'shell.nav.groups.logs',
    icon: 'i-lucide-scroll-text',
    routePrefixes: ['/logs'],
    sections: [[{ label: 'shell.nav.items.logs', icon: 'i-lucide-scroll-text', to: '/logs' }]]
  },
  {
    key: 'docs',
    label: 'shell.nav.groups.docs',
    icon: 'i-lucide-book-open',
    routePrefixes: ['/docs'],
    sections: [[
      { label: 'shell.nav.items.documentation', type: 'label' },
      { label: 'shell.nav.items.endpoints', icon: 'i-lucide-route', to: '/docs/endpoints' },
      { label: 'shell.nav.items.openapi', icon: 'i-lucide-file-code', to: '/docs/openapi' }
    ]]
  },
  {
    key: 'settings',
    label: 'shell.nav.groups.settings',
    icon: 'i-lucide-settings',
    routePrefixes: ['/settings'],
    // PostgreSQL = the database itself (its connection, maintenance, backups, the SQL Console);
    // Access = who gets in and how; Security = protecting the instance;
    // Data API = what the generic API's callers are held to; Features =
    // each admin module's own knobs. Labels match each page's own header
    // (SETTINGS_GROUP_METADATA in @totalbase/settings).
    sections: [
      [
        { label: 'shell.nav.items.general', type: 'label' },
        { label: 'shell.nav.items.general', icon: 'i-lucide-globe', to: '/settings/system' },
        { label: 'shell.nav.items.appearance', icon: 'i-lucide-palette', to: '/settings/appearance' },
        { label: 'shell.nav.items.emailSmtp', icon: 'i-lucide-send', to: '/settings/smtp' },
        { label: 'shell.nav.items.s3Storage', icon: 'i-lucide-cloud', to: '/settings/s3' }
      ],
      [
        { label: 'shell.nav.items.postgresql', type: 'label' },
        { label: 'shell.nav.items.connector', icon: 'i-lucide-plug', to: '/settings/connector' },
        { label: 'shell.nav.items.maintenance', icon: 'i-lucide-wrench', to: '/settings/maintenance' },
        { label: 'shell.nav.items.backups', icon: 'i-lucide-archive', to: '/settings/backups' },
        { label: 'shell.nav.items.sqlConsole', icon: 'i-lucide-terminal', to: '/settings/sql-console' }
      ],
      [
        { label: 'shell.nav.items.access', type: 'label' },
        { label: 'shell.nav.items.authentication', icon: 'i-lucide-log-in', to: '/settings/auth' },
        { label: 'shell.nav.items.authProviders', icon: 'i-lucide-fingerprint', to: '/settings/auth-providers' },
        { label: 'shell.nav.items.tokens', icon: 'i-lucide-key-round', to: '/settings/api-tokens' }
      ],
      [
        { label: 'shell.nav.items.security', type: 'label' },
        { label: 'shell.nav.items.network', icon: 'i-lucide-network', to: '/settings/network' },
        { label: 'shell.nav.items.secrets', icon: 'i-lucide-lock-keyhole', to: '/settings/secrets' },
        { label: 'shell.nav.items.audit', icon: 'i-lucide-scroll-text', to: '/settings/audit' }
      ],
      [
        { label: 'shell.nav.items.dataApi', type: 'label' },
        { label: 'shell.nav.items.limits', icon: 'i-lucide-gauge', to: '/settings/api' },
        { label: 'shell.nav.items.transactions', icon: 'i-lucide-layers', to: '/settings/transactions' },
        { label: 'shell.nav.items.asyncExecutions', icon: 'i-lucide-list-restart', to: '/settings/async-executions' },
        { label: 'shell.nav.items.openapi', icon: 'i-lucide-file-code', to: '/settings/openapi' },
        { label: 'shell.nav.items.mcp', icon: 'i-lucide-bot', to: '/settings/mcp' }
      ],
      [
        { label: 'shell.nav.items.features', type: 'label' },
        { label: 'shell.nav.items.dataviews', icon: 'i-lucide-table', to: '/settings/dataviews' },
        { label: 'shell.nav.items.dashboards', icon: 'i-lucide-layout-dashboard', to: '/settings/dashboards' },
        { label: 'shell.nav.items.maps', icon: 'i-lucide-map', to: '/settings/maps' },
        { label: 'shell.nav.items.files', icon: 'i-lucide-files', to: '/settings/files' },
        { label: 'shell.nav.items.workflows', icon: 'i-lucide-workflow', to: '/settings/workflows' }
      ]
    ]
  }
]

/**
 * The groups with their labels in the UI's language: adminNavGroups holds
 * i18n keys (`shell.nav.*`), every consumer reads the translated copy.
 */
export function translateNavGroups(groups: AdminNavGroup[], t: (key: string) => string): AdminNavGroup[] {
  return groups.map(group => ({
    ...group,
    label: t(group.label),
    sections: group.sections?.map(section => section.map(item => ({ ...item, label: item.label ? t(item.label) : item.label })))
  }))
}

/**
 * Which Settings page edits each registry group - SettingsPanel.vue's
 * search sends a matched key here. A group missing from this map has no
 * page (mail.templates.* are edited under Templates) and isn't searched.
 */
export const SETTINGS_GROUP_ROUTES: Record<string, string> = {
  system: '/settings/system',
  appearance: '/settings/appearance',
  smtp: '/settings/smtp',
  s3: '/settings/s3',
  backups: '/settings/backups',
  pool: '/settings/connector',
  catalog: '/settings/connector',
  auth: '/settings/auth',
  api_keys: '/settings/api-tokens',
  security: '/settings/network',
  audit: '/settings/audit',
  api: '/settings/api',
  query: '/settings/api',
  transactions: '/settings/transactions',
  idempotency: '/settings/transactions',
  async_executions: '/settings/async-executions',
  outbox: '/settings/async-executions',
  openapi: '/settings/openapi',
  dataviews: '/settings/dataviews',
  dashboards: '/settings/dashboards',
  maps: '/settings/maps',
  files: '/settings/files',
  workflows: '/settings/workflows',
  sql_console: '/settings/sql-console',
  mcp: '/settings/mcp'
}

/** The element id SettingsGroupForm.vue gives a setting - a URL hash target (no dots, which a CSS id selector would read as classes). */
export function settingAnchor(key: string): string {
  return `setting-${key.replaceAll('.', '-')}`
}

/**
 * A rail click's target: Dashboard's own `to`, or otherwise the first
 * real link in the group's sections (skipping subgroup label items) -
 * clicking Database jumps straight to Tables rather than just opening
 * the panel and leaving the admin on whatever page it was already on.
 */
export function firstRouteInGroup(group: AdminNavGroup): string | undefined {
  if (group.to) return group.to
  for (const section of group.sections ?? []) {
    for (const item of section) {
      if (item.type !== 'label' && typeof item.to === 'string') return item.to
    }
  }
  return undefined
}
