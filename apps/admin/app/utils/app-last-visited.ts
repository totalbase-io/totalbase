import type { MenuNode, MenuObject, MenuObjectKind } from '~/types/app-menu'

/**
 * Where the App opens (Security.md §8.1): the object the viewer
 * last visited in this browser, remembered per user in localStorage by
 * plugins/app-last-visited.client.ts - a per-browser convenience, nothing
 * of the account -, if the menu still shows it; else the role's home; else the
 * first object of the menu. Pure helpers, tested apart.
 */

export interface AppLocation {
  kind: MenuObjectKind
  slug: string
}

const PATHS: Record<MenuObjectKind, string> = { DATAVIEW: '/app/dataviews/', DASHBOARD: '/app/dashboards/' }

/** The object a path under the App belongs to - a record's page counts for its DataView. */
export function appLocationFromPath(path: string): AppLocation | undefined {
  for (const [kind, prefix] of Object.entries(PATHS) as Array<[MenuObjectKind, string]>) {
    if (!path.startsWith(prefix)) continue
    const slug = path.slice(prefix.length).split('/', 1)[0]
    if (slug) return { kind, slug: decodeURIComponent(slug) }
  }
  return undefined
}

function storageKey(userId: string): string {
  return `totalbase:app:last:${userId}`
}

export function rememberAppLocation(userId: string, location: AppLocation): void {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(location))
  } catch {
    // Private mode or blocked storage: the App simply opens on the home or the first object next time.
  }
}

export function storedAppLocation(userId: string): AppLocation | undefined {
  try {
    const raw = localStorage.getItem(storageKey(userId))
    if (!raw) return undefined
    const value = JSON.parse(raw) as Partial<AppLocation>
    return (value.kind === 'DATAVIEW' || value.kind === 'DASHBOARD') && typeof value.slug === 'string' ? { kind: value.kind, slug: value.slug } : undefined
  } catch {
    return undefined
  }
}

/** The objects of the menu in reading order - groups walked depth-first. */
export function menuObjects(nodes: readonly MenuNode[]): MenuObject[] {
  return nodes.flatMap(node => (node.kind === 'GROUP' ? menuObjects(node.children) : [node]))
}

/** Where the App opens for this viewer, given their menu: the last visited object it still shows, else the home, else its first object. */
export function appOpeningLocation(nodes: readonly MenuNode[], home: AppLocation | null | undefined, last: AppLocation | undefined): AppLocation | undefined {
  const objects = menuObjects(nodes)
  const shown = (location: AppLocation | null | undefined) => location && objects.some(object => object.kind === location.kind && object.slug === location.slug) ? location : undefined
  return shown(last) ?? shown(home) ?? objects[0]
}
