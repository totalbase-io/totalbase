<script setup lang="ts">
/**
 * The App menu's edit mode (Security.md §8.2), on the
 * App's own screen: groups and one level of subgroups; DataViews, Dashboards,
 * modules and groups dragged into place on the shared tree (TreeView.vue - drag, or Alt+arrows; Enter or F2 edits).
 * Each row reads [drag][icon] Name … [Edit]:
 * a group's Edit (AppMenuGroupModal) renames it, gives it its icons, adds a
 * subgroup or deletes it (its entries move up to its parent); an item's
 * (AppMenuItemModal) sets how it shows in the menu or removes it from the
 * menu - its `scope` (EMBEDDED_ONLY), saved at once - and the Hidden section
 * below lists those, each with Show; a module's (AppMenuModuleModal) sets its
 * label and icon or takes it out of the arrangement; a module's switch in the
 * settings (Users, Roles, Files, Templates, Logs - each once) puts it in at
 * the end of the root, or takes it out. Every arrangement
 * change autosaves the whole tree (PUT /admin/api/app/menu), and the App's
 * panel follows at once. The menu's settings (AppMenuSettingsFields.vue:
 * display, groups, search, the App's shell and the standalone menu's header -
 * Admin_UI.md §3.1.1) sit in a column to the right of the tree - on a compact
 * screen behind the header's ⚙, in a slideover (§8); modules only count in
 * the standalone shell, where the menu is the rail, so their switches show
 * only there and placed modules show muted meanwhile. The header's "⋮" sorts the
 * whole menu by name or type, after a confirmation (utils/app-menu-sort.ts).
 */
import { DATAVIEW_TYPE_META, type DataViewType } from '~/types/dataview'
import { APP_MENU_SETTING_KEYS, type AppMenuSettings, type AppShell, type MenuEntry, type MenuGroup, type MenuGroupOpenState, type MenuGroupsOpen, type MenuHeader, type MenuMode, type MenuModule, type MenuModuleName, type MenuNode, type MenuObject, type MenuSearch } from '~/types/app-menu'
import { menuEntryLabel, moduleNav, placedModules } from '~/utils/app-menu-modules'
import { sortMenu, type MenuSortDirection, type MenuSortKey } from '~/utils/app-menu-sort'
import type { DropdownMenuItem } from '@nuxt/ui'
import type { TreeMove, TreeNode } from '~/components/TreeView.vue'

const api = useAdminApi()
const { t } = useI18n()
const notifyError = useErrorToast()
const { refresh: refreshPanel } = useAppMenu()
const session = useSession()
const ui = useUiLocale()

const nodes = ref<MenuNode[]>([])
const hidden = ref<MenuObject[]>([])
/** The menu's settings (app.*), edited in the slideover; `shell` decides whether modules count. */
const settings = reactive<AppMenuSettings>({ mode: 'TREE', groupsOpen: 'CURRENT', search: 'AUTO', shell: 'SHARED', menuHeader: 'LOGO_AND_NAME' })
const standalone = computed(() => settings.shell === 'STANDALONE')
async function load() {
  const { data } = await api.get<{ mode: MenuMode, groupsOpen: MenuGroupsOpen, search: MenuSearch, shell: AppShell, menuHeader: MenuHeader, nodes: MenuNode[], hidden: MenuObject[] }>('/app/menu')
  nodes.value = data.nodes
  hidden.value = data.hidden
  Object.assign(settings, { mode: data.mode, groupsOpen: data.groupsOpen, search: data.search ?? 'AUTO', shell: data.shell, menuHeader: data.menuHeader })
}
const { error: loadError } = await useAsyncData('app-menu-editor', async () => {
  await load()
  return true
})

// --- Saving: the whole arrangement, debounced by useAutosave. ---
type MenuInput
  = | { kind: 'GROUP', id: string, name: string, icon: string | null, iconOpen: string | null, openState: MenuGroupOpenState, children: MenuInput[] }
    | { kind: 'MODULE', id: string, module: MenuModuleName, name: string | null, icon: string | null }
    | { kind: MenuObject['kind'], id: string }
function toInput(list: MenuNode[]): MenuInput[] {
  return list.map((node): MenuInput => {
    if (node.kind === 'GROUP') return { kind: 'GROUP', id: node.id, name: node.name, icon: node.icon, iconOpen: node.iconOpen, openState: node.openState, children: toInput(node.children) }
    if (node.kind === 'MODULE') return { kind: 'MODULE', id: node.id, module: node.module, name: node.name, icon: node.icon }
    return { kind: node.kind, id: node.id }
  })
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

// --- The settings (the slideover): each change saved at once, tracked by the page's autosave. ---
const settingsOpen = ref(false)
async function setSetting(key: keyof AppMenuSettings, value: string) {
  ;(settings as Record<string, string>)[key] = value
  try {
    await autosave.track(api.patch('/settings/app', { data: { [APP_MENU_SETTING_KEYS[key]]: value } }))
    // The layout reads the shell from the session (See as shows it at once); the panel the rest.
    await Promise.all([key === 'shell' ? session.refreshProfile() : Promise.resolve(), refreshPanel()])
  } catch (err) {
    notifyError(err, t('settings.appMenuEditor.displayError'))
  }
}
// A desktop shows the settings beside the tree; a compact screen has no room for two columns - the header's ⚙
// opens them in a slideover (the designer's rule, Admin_UI.md §8: content yes, layout no).
const isCompact = useCompactUi()
const headerActions = computed<HeaderAction[]>(() => (isCompact.value
  ? [{ label: t('settings.appMenuEditor.settings'), icon: 'i-lucide-settings-2', iconOnly: true, onSelect: () => { settingsOpen.value = true } }]
  : []))

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
  nodes.value = sortMenu(nodes.value, sortKey.value, sortDirection.value, entryKindLabel, ui.intlLocale.value, entry => menuEntryLabel(entry, t))
  sortKey.value = null
  changed()
}

// --- Modules (Security.md §8.2): Users, Roles, Files, Templates, Logs as entries - each once, by its switch in
// the settings: on puts it at the end of the root (dragged into place from there), off takes it out. Who sees one
// is their permissions (§9.2), decided by the server - never set here. ---
const placed = computed(() => placedModules(nodes.value))
function toggleModule(module: MenuModuleName, on: boolean) {
  const current = findModule(module)
  if (on && !current) nodes.value.push({ kind: 'MODULE', id: crypto.randomUUID(), module, name: null, icon: null })
  else if (!on && current) detach(current.id)
  else return
  changed()
}
function findModule(module: MenuModuleName, list: MenuNode[] = nodes.value): MenuModule | null {
  for (const node of list) {
    if (node.kind === 'MODULE' && node.module === module) return node
    if (node.kind === 'GROUP') {
      const found = findModule(module, node.children)
      if (found) return found
    }
  }
  return null
}
const editedModule = ref<MenuModule | null>(null)
const moduleModalOpen = ref(false)
function editModule(module: MenuModule) {
  editedModule.value = module
  moduleModalOpen.value = true
}
function saveModule(change: { name: string | null, icon: string | null }) {
  if (!editedModule.value) return
  Object.assign(editedModule.value, change)
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
const moduleOf = (node: TreeNode<unknown>) => node.data as MenuModule
/** What a row shows for an entry: an object's label or name, a module's label or rail name. */
const entryLabel = (node: TreeNode<unknown>) => menuEntryLabel(node.data as MenuEntry, t)
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
  else if (node.kind === 'MODULE') editModule(node)
  else editObject(node)
}

function objectIcon(object: MenuObject): string {
  if (object.icon) return object.icon
  if (object.kind === 'DASHBOARD') return 'i-lucide-layout-dashboard'
  return DATAVIEW_TYPE_META[object.viewType as DataViewType]?.icon ?? 'i-lucide-table'
}
/** "Dashboard", "Module", or "DataView · Kanban" - the DataView's type too, not just that it is one. */
function entryKindLabel(entry: MenuEntry): string {
  if (entry.kind === 'MODULE') return t('settings.appMenuEditor.moduleBadge')
  if (entry.kind === 'DASHBOARD') return 'Dashboard'
  const type = DATAVIEW_TYPE_META[entry.viewType as DataViewType]?.label
  return type ? `DataView · ${type}` : 'DataView'
}
</script>

<template>
  <PageShell
    :scroll="false"
    flush
  >
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
      class="m-4 sm:m-6"
    />
    <!-- Two columns, each with its own scroll: the tree, and the settings to its right (a compact screen: the ⚙). -->
    <div
      v-else
      class="flex min-h-0 flex-1"
    >
      <div class="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div class="mx-auto flex w-full max-w-2xl flex-col">
          <div class="mb-2 flex items-center gap-2">
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
              <template v-else-if="entry(node).kind === 'MODULE'">
                <UIcon
                  :name="moduleOf(node).icon ?? moduleNav(moduleOf(node).module).icon"
                  class="size-4 shrink-0"
                  :class="standalone ? 'text-muted' : 'text-dimmed'"
                />
                <span
                  class="min-w-0 flex-1 truncate text-sm"
                  :class="standalone ? 'text-highlighted' : 'text-muted'"
                >{{ entryLabel(node) }}</span>
                <span
                  v-if="!standalone"
                  class="truncate text-xs text-muted"
                >{{ t('settings.appMenuEditor.moduleStandaloneOnly') }}</span>
                <UBadge
                  :label="t('settings.appMenuEditor.moduleBadge')"
                  color="neutral"
                  variant="subtle"
                  size="sm"
                />
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
                  :label="entryKindLabel(objectOf(node))"
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
                :aria-label="t('settings.appMenuEditor.editItem', { name: entry(node).kind === 'GROUP' ? entry(node).name : entryLabel(node) })"
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
                :label="entryKindLabel(object)"
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
      </div>
      <aside
        v-if="!isCompact"
        :aria-label="t('settings.appMenuEditor.settings')"
        class="w-80 shrink-0 overflow-y-auto border-l border-default p-4"
      >
        <h2 class="mb-4 text-sm font-semibold text-highlighted">
          {{ t('settings.appMenuEditor.settings') }}
        </h2>
        <AppMenuSettingsFields
          :settings="settings"
          :placed-modules="placed"
          @change="setSetting"
          @toggle-module="toggleModule"
        />
      </aside>
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
    <AppMenuSettingsSlideover
      v-if="isCompact"
      v-model:open="settingsOpen"
      :settings="settings"
      :placed-modules="placed"
      @change="setSetting"
      @toggle-module="toggleModule"
    />
    <AppMenuModuleModal
      v-model:open="moduleModalOpen"
      :module="editedModule"
      @save="saveModule"
      @remove="editedModule && toggleModule(editedModule.module, false)"
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
