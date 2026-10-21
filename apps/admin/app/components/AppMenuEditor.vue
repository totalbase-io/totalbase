<script setup lang="ts">
/**
 * The App menu's edit mode (Security.md §8.2), on the
 * App's own screen: groups and one level of subgroups; DataViews, Dashboards
 * and groups dragged into place on the shared tree (TreeView.vue - drag, or Alt+arrows; Enter or F2 edits).
 * Each row reads [drag][icon] Name … [Edit]:
 * a group's Edit (AppMenuGroupModal) renames it, gives it its icons, adds a
 * subgroup or deletes it (its entries move up to its parent); an item's
 * (AppMenuItemModal) sets how it shows in the menu or removes it from the
 * menu - its `scope` (EMBEDDED_ONLY), saved at once - and the Hidden section
 * below lists those, each with Show. Every arrangement change autosaves the
 * whole tree (PUT /admin/api/app/menu), and the App's panel follows at once.
 * The header's "⋮" sorts the whole menu by name or type, after a
 * confirmation (utils/app-menu-sort.ts).
 */
import { DATAVIEW_TYPE_META, type DataViewType } from '~/types/dataview'
import type { MenuGroup, MenuGroupOpenState, MenuGroupsOpen, MenuMode, MenuNode, MenuObject } from '~/types/app-menu'
import { sortMenu, type MenuSortDirection, type MenuSortKey } from '~/utils/app-menu-sort'
import type { DropdownMenuItem } from '@nuxt/ui'
import type { TreeMove, TreeNode } from '~/components/TreeView.vue'

const api = useAdminApi()
const { t } = useI18n()
const notifyError = useErrorToast()
const { refresh: refreshPanel } = useAppMenu()
const ui = useUiLocale()

const nodes = ref<MenuNode[]>([])
const hidden = ref<MenuObject[]>([])
const mode = ref<MenuMode>('TREE')
const groupsOpen = ref<MenuGroupsOpen>('CURRENT')
type MenuSearch = 'AUTO' | 'ALWAYS' | 'NEVER'
const search = ref<MenuSearch>('AUTO')
async function load() {
  const { data } = await api.get<{ mode: MenuMode, groupsOpen: MenuGroupsOpen, search: MenuSearch, nodes: MenuNode[], hidden: MenuObject[] }>('/app/menu')
  nodes.value = data.nodes
  hidden.value = data.hidden
  mode.value = data.mode
  groupsOpen.value = data.groupsOpen
  search.value = data.search ?? 'AUTO'
}
const { error: loadError } = await useAsyncData('app-menu-editor', async () => {
  await load()
  return true
})

// --- Saving: the whole arrangement, debounced by useAutosave. ---
type MenuInput = { kind: 'GROUP', id: string, name: string, icon: string | null, iconOpen: string | null, openState: MenuGroupOpenState, children: MenuInput[] } | { kind: MenuObject['kind'], id: string }
function toInput(list: MenuNode[]): MenuInput[] {
  return list.map(node => node.kind === 'GROUP'
    ? { kind: 'GROUP', id: node.id, name: node.name, icon: node.icon, iconOpen: node.iconOpen, openState: node.openState, children: toInput(node.children) }
    : { kind: node.kind, id: node.id })
}
const autosave = useAutosave(async () => {
  try {
    await api.put('/app/menu', { data: { nodes: toInput(nodes.value) } })
    await refreshPanel()
  } catch (err) {
    notifyError(err, t('settings.appMenuEditor.saveError'))
    throw err
  }
})
function changed() {
  autosave.schedule()
}

async function setMode(next: MenuMode) {
  mode.value = next
  try {
    await autosave.track(api.patch('/settings/app', { data: { menu_mode: next } }))
    await refreshPanel()
  } catch (err) {
    notifyError(err, t('settings.appMenuEditor.displayError'))
  }
}
/** How the tree menu's groups start - the menu's own setting; a group may set its own (its Edit). */
const GROUPS_OPEN_ITEMS = computed<{ label: string, value: MenuGroupsOpen }[]>(() => [
  { label: t('settings.appMenuEditor.groupsOpenCurrent'), value: 'CURRENT' },
  { label: t('settings.appMenuEditor.groupsOpenAll'), value: 'OPEN' },
  { label: t('settings.appMenuEditor.groupsClosedAll'), value: 'CLOSED' }
])
async function setGroupsOpen(next: MenuGroupsOpen) {
  groupsOpen.value = next
  try {
    await autosave.track(api.patch('/settings/app', { data: { menu_groups_open: next } }))
    await refreshPanel()
  } catch (err) {
    notifyError(err, t('settings.appMenuEditor.displayError'))
  }
}
/** The menu's search box (app.menu_search, Security.md §8.2): automatic - past 15 entries a viewer sees -, always, never. */
const SEARCH_ITEMS = computed<{ label: string, value: MenuSearch }[]>(() => [
  { label: t('settings.appMenuEditor.searchAuto'), value: 'AUTO' },
  { label: t('settings.appMenuEditor.searchAlways'), value: 'ALWAYS' },
  { label: t('settings.appMenuEditor.searchNever'), value: 'NEVER' }
])
async function setSearch(next: MenuSearch) {
  search.value = next
  try {
    await autosave.track(api.patch('/settings/app', { data: { menu_search: next } }))
    await refreshPanel()
  } catch (err) {
    notifyError(err, t('settings.appMenuEditor.displayError'))
  }
}
const MODE_ITEMS = computed<{ label: string, value: MenuMode }[]>(() => [{ label: t('settings.appMenuEditor.tree'), value: 'TREE' }, { label: t('settings.appMenuEditor.sidebar'), value: 'SIDEBAR' }])
// Header: how the App shows the menu (a choice, as a menu of its own) - a button on desktop, PageHeader's "⋮" on a
// phone. New group sits above the tree.
const headerActions = computed<HeaderAction[]>(() => [
  {
    label: t('settings.appMenuEditor.display', { mode: MODE_ITEMS.value.find(item => item.value === mode.value)?.label ?? '' }),
    icon: 'i-lucide-panel-left',
    children: MODE_ITEMS.value.map(item => ({
      label: item.label,
      type: 'checkbox' as const,
      checked: mode.value === item.value,
      onSelect: () => { void setMode(item.value) }
    }))
  }
])

// --- Hide / show: the object's own `scope` (Security.md §8.1),
// not part of the arrangement. A pending arrangement save goes first, and
// the menu is read again after - showing an object puts it back where the
// server places it. ---
const togglingId = ref<string | null>(null)
async function setListed(object: MenuObject, listed: boolean) {
  togglingId.value = object.id
  try {
    await autosave.flush()
    await autosave.track(api.patch(`/${object.kind === 'DATAVIEW' ? 'dataviews' : 'dashboards'}/${object.id}`, { data: { scope: listed ? 'LISTED' : 'EMBEDDED_ONLY' } }))
    await load()
    await refreshPanel()
  } catch (err) {
    notifyError(err, t(listed ? 'settings.appMenuEditor.showError' : 'settings.appMenuEditor.hideError'))
  } finally {
    togglingId.value = null
  }
}

// --- Leaving: a DataView's name opens its settings, a Dashboard's its
// editor - after any pending arrangement save, as Done waits for it too. ---
function objectAdminPath(object: MenuObject): string {
  return object.kind === 'DATAVIEW' ? `/dataviews/${object.id}/settings` : `/dashboards/${object.id}`
}
/** The item modal's "Open settings": a DataView's General section - where its presentation in the App is. */
function objectSettingsPath(object: MenuObject): string {
  return object.kind === 'DATAVIEW' ? `${objectAdminPath(object)}?section=general` : objectAdminPath(object)
}
async function leaveTo(path: string) {
  await autosave.flush().catch(() => undefined)
  await navigateTo(path)
}
/** A plain click waits for the save; Ctrl/Cmd/Shift+click keeps the browser's own (a new tab). */
function onNameClick(event: MouseEvent, object: MenuObject) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  void leaveTo(objectAdminPath(object))
}

// --- Sorting: the "⋮" picks the key, a small modal the direction. ---
const sortKey = ref<MenuSortKey | null>(null)
const sortDirection = ref<MenuSortDirection>('ASC')
const sortOpen = computed({
  get: () => sortKey.value !== null,
  set: (open: boolean) => {
    if (!open) sortKey.value = null
  }
})
const headerMenu = computed<DropdownMenuItem[][]>(() => [[
  { label: t('settings.appMenuEditor.sortByName'), icon: 'i-lucide-arrow-down-a-z', disabled: nodes.value.length === 0, onSelect: () => openSort('NAME') },
  { label: t('settings.appMenuEditor.sortByType'), icon: 'i-lucide-shapes', disabled: nodes.value.length === 0, onSelect: () => openSort('TYPE') }
]])
const SORT_DIRECTIONS = computed(() => [
  { label: t('settings.appMenuEditor.ascending'), value: 'ASC' },
  { label: t('settings.appMenuEditor.descending'), value: 'DESC' }
])
function openSort(key: MenuSortKey) {
  sortDirection.value = 'ASC'
  sortKey.value = key
}
function applySort() {
  if (!sortKey.value) return
  nodes.value = sortMenu(nodes.value, sortKey.value, sortDirection.value, objectKindLabel, ui.intlLocale.value)
  sortKey.value = null
  changed()
}

// --- Tree helpers: a node lives in `nodes` or in one group's children. ---
function containerOf(id: string, list: MenuNode[] = nodes.value): MenuNode[] | null {
  for (const node of list) {
    if (node.id === id) return list
    if (node.kind === 'GROUP') {
      const found = containerOf(id, node.children)
      if (found) return found
    }
  }
  return null
}
function findGroup(id: string, list: MenuNode[] = nodes.value): MenuGroup | null {
  for (const node of list) {
    if (node.kind !== 'GROUP') continue
    if (node.id === id) return node
    const found = findGroup(id, node.children)
    if (found) return found
  }
  return null
}
function detach(id: string): MenuNode | null {
  const list = containerOf(id)
  const index = list?.findIndex(n => n.id === id) ?? -1
  return list && index >= 0 ? list.splice(index, 1)[0]! : null
}

/** The menu as the shared tree takes it (TreeView.vue): a group holds its entries, an object is a leaf. */
const treeNodes = computed<TreeNode<MenuNode>[]>(() => {
  const toTree = (list: MenuNode[]): TreeNode<MenuNode>[] => list.map(node => (node.kind === 'GROUP'
    ? { id: node.id, data: node, children: toTree(node.children) }
    : { id: node.id, data: node }))
  return toTree(nodes.value)
})
const collapsedGroups = ref<string[]>([])
/** A tree node's menu entry - TreeView's slots don't carry its data's type. */
const entry = (node: TreeNode<unknown>) => node.data as MenuNode
const objectOf = (node: TreeNode<unknown>) => node.data as MenuObject
function findNode(id: string, list: MenuNode[] = nodes.value): MenuNode | null {
  for (const node of list) {
    if (node.id === id) return node
    if (node.kind === 'GROUP') {
      const found = findNode(id, node.children)
      if (found) return found
    }
  }
  return null
}

// --- Groups ---
function newGroup(parent: MenuGroup | null) {
  const group: MenuGroup = { kind: 'GROUP', id: crypto.randomUUID(), name: parent ? t('settings.appMenuEditor.newSubgroup') : t('settings.appMenuEditor.newGroup'), icon: null, iconOpen: null, openState: 'DEFAULT', children: [] }
  ;(parent ? parent.children : nodes.value).unshift(group)
  changed()
  editGroup(group)
}
/** Its entries move up to where the group was. */
function removeGroup(group: MenuGroup) {
  const list = containerOf(group.id)
  if (!list) return
  list.splice(list.indexOf(group), 1, ...group.children)
  changed()
}

// --- Edit: a group's modal, or an item's. ---
const editedGroup = ref<MenuGroup | null>(null)
const groupModalOpen = ref(false)
function editGroup(group: MenuGroup) {
  editedGroup.value = group
  groupModalOpen.value = true
}
function saveGroup(change: { name: string, icon: string | null, iconOpen: string | null, openState: MenuGroupOpenState }) {
  const group = editedGroup.value
  if (!group) return
  Object.assign(group, change)
  changed()
}
const editedObject = ref<MenuObject | null>(null)
const itemModalOpen = ref(false)
function editObject(object: MenuObject) {
  editedObject.value = object
  itemModalOpen.value = true
}
/** Its fields are its own - saved by the modal; the tree shows them and the App's panel reads them again. */
async function objectSaved(saved: MenuObject) {
  const object = findNode(saved.id) as MenuObject | null
  if (object) Object.assign(object, saved)
  await refreshPanel()
}
const hasSubgroups = (group: MenuGroup) => group.children.some(c => c.kind === 'GROUP')

// --- Moving (TreeView: a drag, or Alt+arrows) - groups nest one level: a group only at the root or inside a root
// group, and one with subgroups only at the root. ---
function canPlace(id: string | null, parentGroupId: string | null): boolean {
  const node = id ? findNode(id) : null
  if (!node) return false
  if (parentGroupId === null) return true
  if (!findGroup(parentGroupId)) return false
  if (node.kind === 'GROUP') {
    if (hasSubgroups(node)) return false
    return nodes.value.some(n => n.id === parentGroupId)
  }
  return true
}
function onMove(move: TreeMove) {
  const moved = detach(move.id)
  if (!moved) return
  const list = move.parent ? findGroup(move.parent)!.children : nodes.value
  list.splice(Math.min(move.index, list.length), 0, moved)
  changed()
}
function editNode(id: string) {
  const node = findNode(id)
  if (!node) return
  if (node.kind === 'GROUP') editGroup(node)
  else editObject(node)
}

function objectIcon(object: MenuObject): string {
  if (object.icon) return object.icon
  if (object.kind === 'DASHBOARD') return 'i-lucide-layout-dashboard'
  return DATAVIEW_TYPE_META[object.viewType as DataViewType]?.icon ?? 'i-lucide-table'
}
/** "Dashboard", or "DataView · Kanban" - the DataView's type too, not just that it is one. */
function objectKindLabel(object: MenuObject): string {
  if (object.kind === 'DASHBOARD') return 'Dashboard'
  const type = DATAVIEW_TYPE_META[object.viewType as DataViewType]?.label
  return type ? `DataView · ${type}` : 'DataView'
}
</script>

<template>
  <PageShell>
    <template #header>
      <PageHeader
        :title="t('settings.appMenu.arrangeMenu')"
        :description="t('settings.appMenuEditor.description')"
        icon="i-lucide-list-tree"
        :actions="headerActions"
        :menu="headerMenu"
      >
        <template #status>
          <SaveStatus :status="autosave.status.value" />
        </template>
        <UButton
          :label="t('common.done')"
          @click="leaveTo('/app')"
        />
      </PageHeader>
    </template>

    <UAlert
      v-if="loadError"
      color="error"
      variant="subtle"
      :title="loadError.message"
    />
    <div
      v-else
      class="mx-auto flex w-full max-w-2xl flex-col"
    >
      <div class="mb-2 flex flex-wrap items-end justify-between gap-2">
        <!-- The menu's settings side by side, level - their help in a popover at the end of each label's line (FieldHelp in the hint). -->
        <div class="flex flex-wrap items-end gap-3">
          <UFormField
            v-if="mode === 'TREE'"
            :label="t('settings.appMenuEditor.groupsOpen')"
          >
            <template #hint>
              <FieldHelp
                :text="t('settings.metadata.keys.app__menu_groups_open.description')"
                :label="t('settings.appMenuEditor.groupsOpen')"
              />
            </template>
            <USelect
              :model-value="groupsOpen"
              :items="GROUPS_OPEN_ITEMS"
              class="w-56"
              @update:model-value="(value: MenuGroupsOpen) => setGroupsOpen(value)"
            />
          </UFormField>
          <UFormField :label="t('settings.appMenuEditor.searchBox')">
            <template #hint>
              <FieldHelp
                :text="t('settings.appMenuEditor.searchBoxHelp')"
                :label="t('settings.appMenuEditor.searchBox')"
              />
            </template>
            <USelect
              :model-value="search"
              :items="SEARCH_ITEMS"
              class="w-40"
              @update:model-value="(value: MenuSearch) => setSearch(value)"
            />
          </UFormField>
        </div>
        <UButton
          :label="t('settings.appMenuEditor.newGroup')"
          icon="i-lucide-folder-plus"
          color="neutral"
          variant="outline"
          @click="newGroup(null)"
        />
      </div>
      <UEmpty
        v-if="nodes.length === 0"
        variant="naked"
        size="sm"
        icon="i-lucide-app-window"
        :title="t('settings.appMenuEditor.emptyTitle')"
        :description="t('settings.appMenuEditor.emptyDescription')"
      />
      <TreeView
        v-else
        v-model:collapsed="collapsedGroups"
        :nodes="treeNodes"
        :label="t('settings.appMenu.arrangeMenu')"
        draggable
        handle
        :can-drop="(id, parent) => canPlace(id, parent)"
        :root-drop-text="t('settings.appMenuEditor.dropAtEnd')"
        :indent="24"
        @move="onMove"
        @activate="editNode"
        @rename="editNode"
      >
        <template #row="{ node }">
          <template v-if="entry(node).kind === 'GROUP'">
            <UIcon
              :name="(entry(node) as MenuGroup).icon ?? 'i-lucide-folder'"
              class="size-4 shrink-0 text-muted"
            />
            <span class="flex-1 truncate text-sm font-semibold text-highlighted">{{ entry(node).name }}</span>
          </template>
          <template v-else>
            <UIcon
              :name="objectIcon(objectOf(node))"
              class="size-4 shrink-0 text-muted"
            />
            <!-- Not draggable itself: a drag started on the name moves the row, not the link. -->
            <span class="min-w-0 flex-1 truncate">
              <ULink
                :to="objectAdminPath(objectOf(node))"
                draggable="false"
                class="text-sm text-highlighted hover:underline"
                @click.stop="onNameClick($event, objectOf(node))"
              >{{ objectOf(node).menuLabel || objectOf(node).name }}</ULink>
            </span>
            <UBadge
              :label="objectKindLabel(objectOf(node))"
              color="neutral"
              variant="subtle"
              size="sm"
            />
          </template>
        </template>
        <template #actions="{ node }">
          <UButton
            icon="i-lucide-pencil"
            color="neutral"
            variant="ghost"
            size="xs"
            :loading="togglingId === node.id"
            :aria-label="t('settings.appMenuEditor.editItem', { name: entry(node).kind === 'GROUP' ? entry(node).name : (objectOf(node).menuLabel || objectOf(node).name) })"
            @click="editNode(node.id)"
          />
        </template>
      </TreeView>

      <template v-if="hidden.length">
        <h3 class="mt-8 text-xs font-semibold uppercase tracking-wide text-muted">
          {{ t('settings.appMenuEditor.hiddenTitle') }}
        </h3>
        <p class="mt-1 mb-2 text-sm text-muted">
          {{ t('settings.appMenuEditor.hiddenDescription') }}
        </p>
        <div
          v-for="object in hidden"
          :key="object.id"
          class="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-elevated"
        >
          <UIcon
            :name="objectIcon(object)"
            class="size-4 shrink-0 text-dimmed"
          />
          <span class="min-w-0 flex-1 truncate">
            <ULink
              :to="objectAdminPath(object)"
              class="text-sm text-muted hover:underline"
              @click="onNameClick($event, object)"
            >{{ object.name }}</ULink>
          </span>
          <UBadge
            :label="objectKindLabel(object)"
            color="neutral"
            variant="subtle"
            size="sm"
          />
          <UButton
            :label="t('settings.appMenuEditor.show')"
            icon="i-lucide-eye"
            color="neutral"
            variant="outline"
            size="xs"
            :loading="togglingId === object.id"
            :aria-label="t('settings.appMenuEditor.showItem', { name: object.name })"
            @click="setListed(object, true)"
          />
        </div>
      </template>
    </div>

    <AppMenuGroupModal
      v-model:open="groupModalOpen"
      :group="editedGroup"
      :can-have-subgroups="!!editedGroup && nodes.some(n => n.id === editedGroup!.id)"
      @save="saveGroup"
      @add-subgroup="editedGroup && newGroup(editedGroup)"
      @remove="editedGroup && removeGroup(editedGroup)"
    />
    <AppMenuItemModal
      v-model:open="itemModalOpen"
      :object="editedObject"
      @saved="objectSaved"
      @remove="editedObject && setListed(editedObject, false)"
      @open-settings="editedObject && leaveTo(objectSettingsPath(editedObject))"
    />

    <UModal
      v-model:open="sortOpen"
      :title="sortKey === 'TYPE' ? t('settings.appMenuEditor.sortByTypeTitle') : t('settings.appMenuEditor.sortByNameTitle')"
      :description="sortKey === 'TYPE' ? t('settings.appMenuEditor.sortByTypeDescription') : t('settings.appMenuEditor.sortByNameDescription')"
    >
      <template #body>
        <URadioGroup
          v-model="sortDirection"
          :items="SORT_DIRECTIONS"
          :aria-label="t('settings.appMenuEditor.direction')"
        />
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="ghost"
            @click="sortOpen = false"
          />
          <UButton
            :label="t('settings.appMenuEditor.sort')"
            @click="applySort"
          />
        </div>
      </template>
    </UModal>
  </PageShell>
</template>
