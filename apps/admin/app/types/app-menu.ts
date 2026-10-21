/** The App menu (Security.md §8) - mirrors @totalbase/app-menu's shapes. */
export type MenuObjectKind = 'DATAVIEW' | 'DASHBOARD'
export type MenuMode = 'TREE' | 'SIDEBAR'
/** How the tree menu's groups start (app.menu_groups_open): CURRENT - only the one holding the page. */
export type MenuGroupsOpen = 'CURRENT' | 'OPEN' | 'CLOSED'
/** A group's own start: DEFAULT - the menu's MenuGroupsOpen. */
export type MenuGroupOpenState = 'DEFAULT' | 'OPEN' | 'CLOSED'

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

export type MenuNode = MenuGroup | MenuObject

export interface AppMenu {
  mode: MenuMode
  groupsOpen: MenuGroupsOpen
  /** Whether it offers a search box (app.menu_search) - AUTO: past MENU_SEARCH_THRESHOLD entries the viewer sees. */
  search?: 'AUTO' | 'ALWAYS' | 'NEVER'
  nodes: MenuNode[]
  /** Where the App opens for this user (Security.md §8.1) - their first role's home they see; null: the App's own page. Not on the admin's arrangement. */
  home?: { kind: MenuObjectKind, slug: string } | null
}

/** Where an item opens inside the App. */
export function menuObjectPath(object: Pick<MenuObject, 'kind' | 'slug'>): string {
  return object.kind === 'DATAVIEW' ? `/app/dataviews/${object.slug}` : `/app/dashboards/${object.slug}`
}
