import type { MenuEntry, MenuModule, MenuModuleName } from '~/types/app-menu'
import { adminNavGroups, firstRouteInGroup } from '~/utils/navigation'
import { menuObjectPath } from '~/types/app-menu'

/**
 * The portal modules the App menu can hold as entries (Security.md §8.2) -
 * the delegated modules of §9.2, in the rail's order. An entry shows the
 * rail group's own label and icon unless it carries its own, and opens the
 * group's page; the server lists it for a viewer by the rail's rule (READ
 * on its table), never as a grant.
 */
export const MENU_MODULES: readonly MenuModuleName[] = ['users', 'roles', 'files', 'templates', 'logs']

/** A module's own presentation: its rail group's label key (`shell.nav.groups.*`), icon and page. */
export function moduleNav(module: MenuModuleName): { labelKey: string, icon: string, to: string } {
  const group = adminNavGroups.find(g => g.key === module)
  return { labelKey: group?.label ?? `shell.nav.groups.${module}`, icon: group?.icon ?? 'i-lucide-square', to: (group && firstRouteInGroup(group)) ?? `/${module}` }
}

/** Where an entry opens: an object inside the App, a module on its page. */
export function menuEntryPath(entry: MenuEntry): string {
  return entry.kind === 'MODULE' ? moduleNav(entry.module).to : menuObjectPath(entry)
}

/** What the menu shows for an entry - a module's own label, else its rail name in the UI's language. */
export function menuEntryLabel(entry: MenuEntry, t: (key: string) => string): string {
  if (entry.kind === 'MODULE') return entry.name || t(moduleNav(entry.module).labelKey)
  return entry.menuLabel || entry.name
}

/** The modules an arrangement holds, at any depth. */
export function placedModules(nodes: readonly { kind: string, children?: readonly unknown[], module?: MenuModuleName }[]): MenuModuleName[] {
  return nodes.flatMap(node => (node.kind === 'GROUP' ? placedModules((node.children ?? []) as typeof nodes) : node.kind === 'MODULE' && node.module ? [node.module] : []))
}

export const isMenuModule = (entry: { kind: string }): entry is MenuModule => entry.kind === 'MODULE'
