<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'
/**
 * The App rail group's panel (layouts/default.vue's aside): the menu the
 * administrator arranged (Specification_Security.md §8), already
 * filtered for this user by the server. TREE shows collapsible groups;
 * SIDEBAR the same menu flat, each group a section heading. An
 * administrator gets the way into edit mode.
 *
 * A TREE group starts as it says (openState), else as the menu says
 * (groupsOpen: only the current page's, all open, all closed); the one
 * holding the current page always opens. What the viewer opens and closes
 * is remembered on this device (a cookie) while the menu's own settings
 * stay the same - an administrator's change wins; Reset forgets it.
 */
import type { NavigationMenuItem } from '@nuxt/ui'
import { DATAVIEW_TYPE_META, type DataViewType } from '~/types/dataview'
import { menuObjectPath, type MenuGroup, type MenuNode, type MenuObject } from '~/types/app-menu'
import { isValidColorValue, roleColorShade } from '~/types/permission'
import { countEntries, filterMenu, foldText, MENU_SEARCH_THRESHOLD } from '~/utils/menu-search'

const { menu, loading, error, refresh } = useAppMenu()
// What the menu lists changes elsewhere (a DataView or Dashboard renamed,
// re-iconed, published or unpublished, a role's access) - revalidate each
// time the panel opens, keeping the cached menu on screen meanwhile.
onMounted(() => {
  if (menu.value !== null && !loading.value) void refresh()
})
const session = useSession()
const { t } = useI18n()
const isAdmin = computed(() => session.access.value === 'ADMIN')
/** A finger has no hover - no tooltip there. */
const isTouch = useIsTouch()

function objectIcon(object: MenuObject): string {
  if (object.icon) return object.icon
  if (object.kind === 'DASHBOARD') return 'i-lucide-layout-dashboard'
  return DATAVIEW_TYPE_META[object.viewType as DataViewType]?.icon ?? 'i-lucide-table'
}
const colorMode = useColorMode()
/**
 * The object's own color (DataView/Dashboard identity) on its icon -
 * `iconColor`, read by the `#item-leading` slot below. UNavigationMenu's
 * `color` only knows the semantic aliases, so the palette shade
 * (roleColorShade, light/dark aware) is applied as an inline color.
 */
function objectItem(object: MenuObject): NavigationMenuItem {
  const iconColor = object.color && isValidColorValue(object.color)
    ? roleColorShade(object.color, colorMode.value === 'dark' ? 'dark' : 'light')
    : undefined
  // Its menu label, else its name; its description is the item's tooltip.
  return { label: object.menuLabel || object.name, icon: objectIcon(object), to: menuObjectPath(object), iconColor, tooltipText: object.description ?? undefined, fullName: object.menuLabel ? object.name : undefined }
}

// --- How the tree's groups start, and what this device remembers. ---
const route = useRoute()
interface GroupsMemory { v: string, open: string[], closed: string[] }
const memory = useCookie<GroupsMemory>('totalbase-menu-groups', { default: () => ({ v: '', open: [], closed: [] }), maxAge: 60 * 60 * 24 * 365, sameSite: 'lax' })
/** The menu's own settings for its groups: what the memory was taken against - a change there drops it. */
const configVersion = computed(() => {
  const states: string[] = []
  const walk = (list: MenuNode[]) => list.forEach((n) => {
    if (n.kind === 'GROUP') {
      states.push(`${n.id}:${n.openState}`)
      walk(n.children)
    }
  })
  walk(menu.value?.nodes ?? [])
  return `${menu.value?.groupsOpen ?? ''}|${states.join(',')}`
})
const remembered = computed(() => (memory.value.v === configVersion.value ? memory.value : { v: configVersion.value, open: [], closed: [] }))
/** The groups holding the current page - always open. */
const currentGroups = computed(() => {
  const found: string[] = []
  const walk = (list: MenuNode[], trail: string[]): boolean => list.some((n) => {
    if (n.kind === 'GROUP') return walk(n.children, [...trail, n.id])
    const path = menuObjectPath(n)
    if (route.path === path || route.path.startsWith(`${path}/`)) {
      found.push(...trail)
      return true
    }
    return false
  })
  walk(menu.value?.nodes ?? [], [])
  return found
})
function startsOpen(group: MenuGroup): boolean {
  if (currentGroups.value.includes(group.id)) return true
  if (remembered.value.open.includes(group.id)) return true
  if (remembered.value.closed.includes(group.id)) return false
  if (group.openState !== 'DEFAULT') return group.openState === 'OPEN'
  return menu.value?.groupsOpen === 'OPEN'
}
/** A group's link carries its id in a class. Caught before the menu toggles it: it becomes what its data-state isn't yet. */
const GROUP_CLASS = 'menu-group-'
function onTreeClick(event: MouseEvent) {
  // A search opens every group it shows - never what this device remembers.
  if (searching.value) return
  const link = (event.target as HTMLElement).closest<HTMLElement>(`[class*="${GROUP_CLASS}"]`)
  const id = link && [...link.classList].find(c => c.startsWith(GROUP_CLASS))?.slice(GROUP_CLASS.length)
  if (!link || !id) return
  const isOpen = link.getAttribute('data-state') !== 'open'
  const next = remembered.value
  memory.value = {
    v: configVersion.value,
    open: isOpen ? [...new Set([...next.open, id])] : next.open.filter(g => g !== id),
    closed: isOpen ? next.closed.filter(g => g !== id) : [...new Set([...next.closed, id])]
  }
}
const resets = ref(0)
const hasMemory = computed(() => remembered.value.open.length + remembered.value.closed.length > 0)
/** Reset shows in a TREE menu once the viewer opened or closed a group on this device. */
const canReset = computed(() => menu.value?.mode !== 'SIDEBAR' && hasMemory.value)
function resetGroups() {
  memory.value = { v: configVersion.value, open: [], closed: [] }
  resets.value++
}
// --- The search box (Specification_Security.md §8.2): over the menu the viewer sees - an AUTO menu past
// MENU_SEARCH_THRESHOLD entries; its results the matching entries in their groups, open, what matched marked.
const query = ref('')
const term = computed(() => query.value.trim())
const searching = computed(() => term.value.length > 0)
const offersSearch = computed(() => {
  const setting = menu.value?.search ?? 'AUTO'
  return setting === 'ALWAYS' || (setting === 'AUTO' && countEntries(menu.value?.nodes ?? []) > MENU_SEARCH_THRESHOLD)
})
const shownNodes = computed(() => (searching.value ? filterMenu(menu.value?.nodes ?? [], term.value) : menu.value?.nodes ?? []))
const searchInput = ref<{ inputRef?: HTMLInputElement } | null>(null)
const panelEl = ref<HTMLElement | null>(null)
/** The result links on screen, in order. */
const resultLinks = () => [...(panelEl.value?.querySelectorAll<HTMLAnchorElement>('nav a[href]') ?? [])]
/** ↓ from the box: the first result - the menu's own arrows step on from there. */
function toResults(event: KeyboardEvent) {
  const first = searching.value ? resultLinks()[0] : undefined
  if (!first) return
  event.preventDefault()
  first.focus()
}
/** Enter in the box opens the first result. */
function openFirst() {
  const first = resultLinks()[0]
  if (first) void navigateTo(first.getAttribute('href')!.replace(/^\/admin/, ''))
}
/** A short label found by its full name ("Mapa" - "Mapa de sucursales"): the name shown beside it, marked. */
function fullNameFound(item: NavigationMenuItem): string | null {
  const name = (item as { fullName?: string }).fullName
  if (!searching.value || !name) return null
  const q = foldText(term.value)
  return !foldText(String(item.label)).includes(q) && foldText(name).includes(q) ? name : null
}
// "/" anywhere brings the box - unless typing in a field.
function onSlash(event: KeyboardEvent) {
  if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || !offersSearch.value) return
  const target = event.target as HTMLElement | null
  if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
  event.preventDefault()
  searchInput.value?.inputRef?.focus()
}
onMounted(() => window.addEventListener('keydown', onSlash))
onBeforeUnmount(() => window.removeEventListener('keydown', onSlash))
// An entry opened: the search clears, the menu back as it was.
watch(() => route.path, () => {
  query.value = ''
})

/** Re-drawn when the page moves into another group, so it opens - or after Reset, or as the search changes. */
const treeKey = computed(() => `${menu.value?.mode}:${currentGroups.value.join(',')}:${resets.value}:${searching.value ? `s:${term.value}` : ''}`)

function treeItems(nodes: MenuNode[]): NavigationMenuItem[] {
  return nodes.map(node => node.kind === 'GROUP'
    ? {
        label: node.name,
        // Closed and open: its own icons - none, a folder that opens; an icon alone, the same in both states.
        icon: node.icon ?? 'i-lucide-folder',
        iconOpen: node.iconOpen ?? node.icon ?? 'i-lucide-folder-open',
        // The link carries data-state (open / closed) - this group's own, never an enclosing group's - and its id.
        class: `group/menu-group ${GROUP_CLASS}${node.id}`,
        value: node.id,
        defaultOpen: searching.value || startsOpen(node),
        children: treeItems(node.children)
      }
    : objectItem(node))
}

/** SIDEBAR: root items first, then one section per root group - its items, and each subgroup as a sub-heading. */
function sidebarSections(nodes: MenuNode[]): NavigationMenuItem[][] {
  const rootItems = nodes.filter((n): n is MenuObject => n.kind !== 'GROUP').map(objectItem)
  const sections: NavigationMenuItem[][] = rootItems.length ? [rootItems] : []
  const flatten = (children: MenuNode[]): NavigationMenuItem[] => children.flatMap(child => child.kind === 'GROUP'
    ? [{ label: child.name, type: 'label' as const }, ...flatten(child.children)]
    : [objectItem(child)])
  for (const node of nodes) {
    if (node.kind === 'GROUP') sections.push([{ label: node.name, type: 'label' }, ...flatten(node.children)])
  }
  return sections
}

const hasOpenIcon = (item: NavigationMenuItem) => typeof item.iconOpen === 'string' && item.iconOpen !== item.icon

const items = computed(() => {
  const nodes = shownNodes.value
  return menu.value?.mode === 'SIDEBAR' ? sidebarSections(nodes) : [treeItems(nodes)]
})
const empty = computed(() => !loading.value && (menu.value?.nodes.length ?? 0) === 0)
// The groups' chevrons are decoration (T59) - hidden from assistive technology.
const menuRef = ref<HTMLElement | ComponentPublicInstance | null>(null)
const viewAsOpen = ref(false)
useMenuChevronA11y(menuRef)
</script>

<template>
  <div
    ref="panelEl"
    class="flex flex-col gap-3"
  >
    <!-- Arrange (an administrator) and, beside it, Reset menu groups - an icon, when there is something to forget. -->
    <div
      v-if="isAdmin || canReset"
      class="flex items-center gap-2"
    >
      <UButton
        v-if="isAdmin"
        :label="t('settings.appMenu.arrangeMenu')"
        icon="i-lucide-list-tree"
        color="neutral"
        variant="outline"
        size="sm"
        block
        class="flex-1"
        to="/app?edit"
      />
      <!-- See as (Specification_Security.md §8.4): the App as a user or a role sees it, read-only. -->
      <UTooltip
        v-if="isAdmin"
        :text="t('shell.viewAs.title')"
      >
        <UButton
          icon="i-lucide-eye"
          color="neutral"
          variant="outline"
          size="sm"
          :aria-label="t('shell.viewAs.title')"
          @click="viewAsOpen = true"
        />
      </UTooltip>
      <UTooltip
        v-if="canReset"
        :text="t('settings.appMenu.resetGroups')"
      >
        <UButton
          icon="i-lucide-rotate-ccw"
          color="neutral"
          variant="outline"
          size="sm"
          :class="isAdmin ? undefined : 'ms-auto'"
          :aria-label="t('settings.appMenu.resetGroups')"
          @click="resetGroups"
        />
      </UTooltip>
    </div>
    <ViewAsModal
      v-if="isAdmin"
      v-model:open="viewAsOpen"
    />
    <UInput
      v-if="offersSearch"
      ref="searchInput"
      v-model="query"
      icon="i-lucide-search"
      :placeholder="t('common.search')"
      size="sm"
      :aria-label="t('settings.appMenu.search')"
      class="w-full"
      @keydown.down="toResults"
      @keydown.enter.prevent="openFirst"
      @keydown.esc="query = ''"
    >
      <template
        v-if="query"
        #trailing
      >
        <UButton
          icon="i-lucide-x"
          color="neutral"
          variant="link"
          size="xs"
          :aria-label="t('settings.appMenu.clearSearch')"
          @click="query = ''"
        />
      </template>
    </UInput>
    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="t('settings.appMenu.loadError')"
    />
    <p
      v-else-if="empty"
      class="px-2 text-sm text-muted"
    >
      {{ t('settings.appMenu.nothingPublished') }}
    </p>
    <p
      v-else-if="searching && shownNodes.length === 0"
      class="px-2 text-sm text-muted"
    >
      {{ t('settings.appMenu.noMatch', { query: term }) }}
    </p>
    <UNavigationMenu
      v-else
      ref="menuRef"
      :key="treeKey"
      :unmount-on-hide="false"
      orientation="vertical"
      :aria-label="t('shell.appMenuLabel')"
      :items="items"
      class="w-full"
      @click.capture="onTreeClick"
    >
      <!-- UNavigationMenu's own leading icon (same classes), plus the object's color when it has one. -->
      <template #item-leading="{ item, active, ui }">
        <UIcon
          v-if="item.icon"
          :name="item.icon"
          data-slot="linkLeadingIcon"
          :class="ui.linkLeadingIcon({ class: [item.ui?.linkLeadingIcon, hasOpenIcon(item) ? 'group-data-[state=open]/menu-group:hidden' : undefined], active, disabled: !!item.disabled })"
          :style="item.iconColor ? { color: item.iconColor } : undefined"
        />
        <!-- A group's open icon, while it is open (a collapsed menu has no state: the closed one). -->
        <UIcon
          v-if="hasOpenIcon(item)"
          :name="item.iconOpen"
          data-slot="linkLeadingIcon"
          :class="ui.linkLeadingIcon({ class: [item.ui?.linkLeadingIcon, 'hidden group-data-[state=open]/menu-group:inline-block'], active, disabled: !!item.disabled })"
        />
      </template>
      <!-- An item's description, on hover (Specification_Security.md §8). -->
      <template #item-label="{ item }">
        <UTooltip
          v-if="item.tooltipText && !isTouch"
          :text="item.tooltipText"
          :content="{ side: 'right' }"
          :delay-duration="400"
        >
          <span><MenuSearchLabel
            :text="String(item.label)"
            :term="term"
          /></span>
        </UTooltip>
        <MenuSearchLabel
          v-else
          :text="String(item.label)"
          :term="term"
        />
        <span
          v-if="fullNameFound(item)"
          class="ms-1 text-xs text-muted"
        ><MenuSearchLabel
          :text="fullNameFound(item)!"
          :term="term"
        /></span>
      </template>
    </UNavigationMenu>
  </div>
</template>
