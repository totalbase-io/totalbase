/** The App menu (Security.md §8) - mirrors @totalbase/app-menu's shapes. */
export type MenuObjectKind = 'DATAVIEW' | 'DASHBOARD'
export type MenuMode = 'TREE' | 'SIDEBAR'
/** How the tree menu's groups start (app.menu_groups_open): CURRENT - only the one holding the page. */
export type MenuGroupsOpen = 'CURRENT' | 'OPEN' | 'CLOSED'
/** A group's own start: DEFAULT - the menu's MenuGroupsOpen. */
export type MenuGroupOpenState = 'DEFAULT' | 'OPEN' | 'CLOSED'
/** How the App is framed for a non-administrator (app.shell, Admin_UI.md §3.1.1): beside the rail, or its menu as the only sidebar. */
export type AppShell = 'SHARED' | 'STANDALONE'
/** What heads the standalone App's menu (app.menu_header). */
export type MenuHeader = 'LOGO_AND_NAME' | 'LOGO' | 'NAME' | 'NONE'
export type MenuSearch = 'AUTO' | 'ALWAYS' | 'NEVER'
/** The menu's settings (app.*), as Arrange menu's settings slideover edits them. */
export interface AppMenuSettings {
  mode: MenuMode
  groupsOpen: MenuGroupsOpen
  search: MenuSearch
  shell: AppShell
  menuHeader: MenuHeader
}
/** The settings' keys as PATCH /admin/api/settings/app takes them. */
export const APP_MENU_SETTING_KEYS: Record<keyof AppMenuSettings, string> = { mode: 'menu_mode', groupsOpen: 'menu_groups_open', search: 'menu_search', shell: 'shell', menuHeader: 'menu_header' }
/** The portal modules the menu can hold (Security.md §9.2) - by the names GET /auth/me's `modules` uses. */
export type MenuModuleName = 'users' | 'roles' | 'files' | 'templates' | 'logs'

export interface MenuObject {
  kind: MenuObjectKind
  id: string
  name: string
  slug: string
  /** What the menu shows - null: its name. */
  menuLabel: string | null
  /** Its description - the menu's tooltip. */
  description: string | null
  icon: string | null
  color: string | null
  viewType: string | null
}

/** A delegated module placed in the menu: shown to a viewer whose roles read its table, like the rail. */
export interface MenuModule {
  kind: 'MODULE'
  id: string
  module: MenuModuleName
  /** What the menu shows - null: the module's own name. */
  name: string | null
  /** null: the module's own icon. */
  icon: string | null
}

export interface MenuGroup {
  kind: 'GROUP'
  id: string
  name: string
  icon: string | null
  /** Shown instead of `icon` while the group is open in the tree menu - null: `icon` in both states. */
  iconOpen: string | null
  openState: MenuGroupOpenState
  children: MenuNode[]
}

/** What a viewer opens: an object, or a module. */
export type MenuEntry = MenuObject | MenuModule
export type MenuNode = MenuGroup | MenuEntry

export interface AppMenu {
  mode: MenuMode
  groupsOpen: MenuGroupsOpen
  /** Whether it offers a search box (app.menu_search) - AUTO: past MENU_SEARCH_THRESHOLD entries the viewer sees. */
  search?: MenuSearch
  nodes: MenuNode[]
  /** Where the App opens for this user (Security.md §8.1) - their first role's home they see; null: the App's own page. Not on the admin's arrangement. */
  home?: { kind: MenuObjectKind, slug: string } | null
}

/** Where an item opens inside the App. */
export function menuObjectPath(object: Pick<MenuObject, 'kind' | 'slug'>): string {
  return object.kind === 'DATAVIEW' ? `/app/dataviews/${object.slug}` : `/app/dashboards/${object.slug}`
}
