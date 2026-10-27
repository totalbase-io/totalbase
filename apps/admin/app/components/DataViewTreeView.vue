<script setup lang="ts">
/**
 * TREE layout of a DataView grid (DataViews.md §5.14): the rows under their parent row - the table's
 * foreign key to itself (`tree_layout.parentColumn`) - as a tree (TreeView) or an org chart. A row whose parent
 * isn't among the rows read (a search, a filter, the cap) shows at the root. A node opens its record; "+" adds a
 * child; a drag (tree only) moves a row under another - an UPDATE of its parent column, and of the order column of
 * its new siblings when there is one. Never under itself: TreeView refuses it, the cycle guard trigger too.
 */
import type { DropdownMenuItem } from '@nuxt/ui'
import type { TreeMove, TreeNode } from './TreeView.vue'
import type { OrgChartItem } from './OrgChartNode.vue'
import type { DataViewField, TreeDisplay, TreeLayoutConfig } from '~/types/dataview'
import { isValidColorValue, roleColorShade } from '~/types/permission'
import { cappedNotice } from '~/utils/dataview-columns'

/** A row as a node - its title, description, icon, color and image from the view's formulas (null image: no image formula). */
export interface TreeItem extends OrgChartItem {
  row: Record<string, unknown>
  /** Its children's count - also shown collapsed. */
  count: number
}

const props = defineProps<{
  rows: Record<string, unknown>[]
  fields: DataViewField[]
  layout?: TreeLayoutConfig
  primaryKey?: string
  dataviewId: string
  canWrite: boolean
  canCreate: boolean
  total: number
  limit: number
  /** Each row's "⋮" (DataViewGrid.vue's rowMenu). */
  rowMenu?: (row: Record<string, unknown>) => DropdownMenuItem[][]
}>()
const emit = defineEmits<{
  'edit': [row: Record<string, unknown>]
  'create': [values: Record<string, unknown>]
  'update-rows': [changes: { row: Record<string, unknown>, data: Record<string, unknown> }[]]
}>()

const { t } = useI18n()
const colorMode = useColorMode()
// Resolved in the row that renders it: a deferred file image is fetched only for the rows shown.
const { resolveFileSrc } = useFileObjectUrl()
const formula = useLayoutFormula(() => props.fields, () => [props.layout?.titleFormula, props.layout?.descriptionFormula, props.layout?.iconFormula, props.layout?.colorFormula, props.layout?.imageFormula])

/** An avatar's derivative: the org chart's (40px) at twice the pixels, the tree's smaller one reuses it. */
const AVATAR_WIDTH = 96

const keyOf = (row: Record<string, unknown>) => String(row[props.primaryKey!])

/** The rows as nodes: each under its parent, siblings by the order column, then by title. */
const nodes = computed<TreeNode<TreeItem>[]>(() => {
  const parentColumn = props.layout?.parentColumn
  if (!parentColumn || !props.primaryKey) return []
  const orderColumn = props.layout?.orderColumn
  const all = new Map<string, TreeNode<TreeItem>>()
  for (const row of props.rows) {
    const color = formula.evaluate(props.layout?.colorFormula, row)
    all.set(keyOf(row), {
      id: keyOf(row),
      children: [],
      data: {
        row,
        title: formula.evaluate(props.layout?.titleFormula, row) || keyOf(row),
        description: props.layout?.descriptionFormula ? formula.evaluate(props.layout.descriptionFormula, row) : '',
        icon: formula.evaluate(props.layout?.iconFormula, row) || null,
        color: color || null,
        image: props.layout?.imageFormula ? (formula.imageSrc(props.layout.imageFormula, row, AVATAR_WIDTH) ?? '') : null,
        count: 0
      }
    })
  }
  const roots: TreeNode<TreeItem>[] = []
  for (const node of all.values()) {
    const parent = node.data.row[parentColumn]
    const holder = parent === null || parent === undefined ? undefined : all.get(String(parent))
    if (holder && holder !== node) holder.children!.push(node)
    else roots.push(node)
  }
  // Rows in a loop (a table without the cycle guard) reach no root: each loop shows from one of its rows.
  const reached = new Set<string>()
  const mark = (node: TreeNode<TreeItem>) => {
    if (reached.has(node.id)) return
    reached.add(node.id)
    node.children!.forEach(mark)
  }
  roots.forEach(mark)
  for (const node of all.values()) {
    if (reached.has(node.id)) continue
    for (const holder of all.values()) holder.children = holder.children!.filter(c => c !== node)
    roots.push(node)
    mark(node)
  }
  const position = (node: TreeNode<TreeItem>) => {
    const value = orderColumn ? Number(node.data.row[orderColumn]) : Number.NaN
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY
  }
  const sort = (list: TreeNode<TreeItem>[]) => {
    list.sort((a, b) => (position(a) - position(b)) || a.data.title.localeCompare(b.data.title))
    for (const node of list) {
      node.data.count = node.children!.length
      sort(node.children!)
    }
  }
  sort(roots)
  return roots
})

// --- Open levels: `expandLevel` the first time this DataView's rows arrive, the viewer's after ------------------

const collapsed = ref<string[]>([])
let seeded = false
watch(nodes, (list) => {
  if (seeded || list.length === 0) return
  seeded = true
  const closed: string[] = []
  const walk = (level: TreeNode<TreeItem>[], depth: number) => level.forEach((node) => {
    if (node.children!.length > 0 && depth >= (props.layout?.expandLevel ?? 1)) closed.push(node.id)
    walk(node.children!, depth + 1)
  })
  walk(list, 0)
  collapsed.value = closed
}, { immediate: true })
function allNodes(): TreeNode<TreeItem>[] {
  const out: TreeNode<TreeItem>[] = []
  const walk = (level: TreeNode<TreeItem>[]) => level.forEach((node) => {
    out.push(node)
    walk(node.children!)
  })
  walk(nodes.value)
  return out
}
const expandAll = () => (collapsed.value = [])
const collapseAll = () => (collapsed.value = allNodes().filter(n => n.children!.length > 0).map(n => n.id))

// --- Tree or org chart: the layout's default, then the viewer's last choice on this browser -----------------------

const DISPLAY_KEY = `totalbase.tree-display.${props.dataviewId}`
function storedDisplay(): TreeDisplay | null {
  try {
    const value = localStorage.getItem(DISPLAY_KEY)
    return value === 'tree' || value === 'org' ? value : null
  } catch {
    return null
  }
}
const display = ref<TreeDisplay>(props.layout?.defaultDisplay ?? 'tree')
onMounted(() => {
  display.value = storedDisplay() ?? display.value
})
watch(() => props.layout?.defaultDisplay, (value) => {
  if (value && !storedDisplay()) display.value = value
})
function setDisplay(value: TreeDisplay) {
  display.value = value
  try {
    localStorage.setItem(DISPLAY_KEY, value)
  } catch { /* a remembered choice is a convenience */ }
}

// --- Writing --------------------------------------------------------------------------------------------------

const draggable = computed(() => props.canWrite && !!props.primaryKey && !!props.layout?.parentColumn)

/** The new parent, and the new order of its children when there is an order column. */
function onMove(move: TreeMove) {
  const parentColumn = props.layout?.parentColumn
  if (!parentColumn) return
  const byId = new Map(allNodes().map(n => [n.id, n]))
  const moved = byId.get(move.id)
  if (!moved) return
  const oldParent = moved.data.row[parentColumn]
  const newParent = move.parent === null ? null : byId.get(move.parent)!.data.row[props.primaryKey!]
  const changes = new Map<string, { row: Record<string, unknown>, data: Record<string, unknown> }>()
  if (String(oldParent ?? '') !== String(newParent ?? '')) changes.set(move.id, { row: moved.data.row, data: { [parentColumn]: newParent } })
  const orderColumn = props.layout?.orderColumn
  if (orderColumn) {
    const siblings = (move.parent === null ? nodes.value : byId.get(move.parent)!.children!).filter(n => n.id !== move.id)
    siblings.splice(move.index, 0, moved)
    siblings.forEach((node, index) => {
      if (Number(node.data.row[orderColumn]) === index + 1) return
      const change = changes.get(node.id) ?? { row: node.data.row, data: {} }
      change.data[orderColumn] = index + 1
      changes.set(node.id, change)
    })
  }
  if (changes.size > 0) emit('update-rows', [...changes.values()])
}
function addChild(node: TreeNode<TreeItem> | null) {
  const parentColumn = props.layout?.parentColumn
  if (!parentColumn) return
  emit('create', node ? { [parentColumn]: node.data.row[props.primaryKey!] } : {})
}
const nodeMenu = (node: TreeNode<TreeItem>) => props.rowMenu?.(node.data.row) ?? []
const toast = useToast()
/** Let go on itself or under its own descendant: never moved - say why. */
function refused(id: string, onto: string) {
  const all = allNodes()
  const name = all.find(n => n.id === id)?.data.title ?? ''
  const target = all.find(n => n.id === onto)?.data.title ?? ''
  toast.add({ title: t('dataviews.treeView.cantMoveUnder', { name, target }), color: 'warning', icon: 'i-lucide-ban' })
}
function activate(id: string) {
  const node = allNodes().find(n => n.id === id)
  if (node) emit('edit', node.data.row)
}

const swatch = (color: string | null) => (color && isValidColorValue(color) ? roleColorShade(color, colorMode.value === 'dark' ? 'dark' : 'light') : undefined)
const capped = computed(() => cappedNotice(props.total, props.limit, t('dataviews.layouts.capWhere.tree')))
</script>

<template>
  <UAlert
    v-if="capped"
    color="warning"
    variant="subtle"
    icon="i-lucide-triangle-alert"
    :title="capped"
  />
  <UEmpty
    v-if="!layout?.parentColumn"
    variant="naked"
    size="sm"
    icon="i-lucide-list-tree"
    :title="t('dataviews.layouts.noParentColumn')"
  />
  <div
    v-else
    class="flex min-h-0 flex-1 flex-col gap-2"
  >
    <div class="flex flex-wrap items-center gap-2">
      <UFieldGroup>
        <UButton
          icon="i-lucide-list-tree"
          :label="t('dataviews.treeView.displays.tree')"
          color="neutral"
          :variant="display === 'tree' ? 'subtle' : 'outline'"
          size="sm"
          :aria-pressed="display === 'tree'"
          @click="setDisplay('tree')"
        />
        <UButton
          icon="i-lucide-network"
          :label="t('dataviews.treeView.displays.org')"
          color="neutral"
          :variant="display === 'org' ? 'subtle' : 'outline'"
          size="sm"
          :aria-pressed="display === 'org'"
          @click="setDisplay('org')"
        />
      </UFieldGroup>
      <UButton
        icon="i-lucide-chevrons-up-down"
        :label="t('dataviews.treeView.expandAll')"
        color="neutral"
        variant="ghost"
        size="sm"
        @click="expandAll"
      />
      <UButton
        icon="i-lucide-chevrons-down-up"
        :label="t('dataviews.treeView.collapseAll')"
        color="neutral"
        variant="ghost"
        size="sm"
        @click="collapseAll"
      />
    </div>

    <UEmpty
      v-if="nodes.length === 0"
      variant="naked"
      size="sm"
      icon="i-lucide-inbox"
      :title="t('dataviews.layouts.noRows')"
    />
    <TreeView
      v-else-if="display === 'tree'"
      v-model:collapsed="collapsed"
      :nodes="nodes"
      :label="t('dataviews.treeView.label')"
      :draggable="draggable"
      :menu="rowMenu ? nodeMenu : undefined"
      :root-drop-text="t('dataviews.treeView.dropAtRoot')"
      :indent="20"
      class="min-h-0 flex-1 overflow-auto"
      @move="onMove"
      @select="activate"
      @activate="activate"
      @drop-refused="refused"
    >
      <template #row="{ node }">
        <div class="flex min-w-0 flex-1 items-center gap-2 py-1">
          <UUser
            v-if="node.data.image !== null"
            :name="node.data.title"
            :description="node.data.description || undefined"
            :avatar="{ src: resolveFileSrc(node.data.image), alt: node.data.title }"
            size="xs"
            class="min-w-0"
          />
          <template v-else>
            <UIcon
              v-if="node.data.icon"
              :name="node.data.icon"
              class="size-4 shrink-0"
              :style="swatch(node.data.color) ? { color: swatch(node.data.color) } : undefined"
            />
            <span
              v-else-if="swatch(node.data.color)"
              class="size-2.5 shrink-0 rounded-full"
              :style="{ backgroundColor: swatch(node.data.color) }"
            />
            <span class="truncate">{{ node.data.title }}</span>
            <span
              v-if="node.data.description"
              class="truncate text-sm text-muted max-md:hidden"
            >{{ node.data.description }}</span>
          </template>
          <!-- How many it holds - seen at a glance; the tree's own aria-expanded says it has children. -->
          <UBadge
            v-if="node.data.count > 0"
            aria-hidden="true"
            :label="String(node.data.count)"
            color="neutral"
            variant="soft"
            size="sm"
          />
        </div>
      </template>
      <template #actions="{ node }">
        <UButton
          v-if="canCreate"
          icon="i-lucide-plus"
          color="neutral"
          variant="ghost"
          size="xs"
          :aria-label="t('dataviews.treeView.addChild', { name: node.data.title })"
          @click.stop="addChild(node)"
        />
        <UDropdownMenu
          v-if="rowMenu && nodeMenu(node).length > 0"
          :items="nodeMenu(node)"
        >
          <UButton
            icon="i-lucide-ellipsis-vertical"
            color="neutral"
            variant="ghost"
            size="xs"
            :aria-label="t('dataviews.treeView.actions', { name: node.data.title })"
            @click.stop
          />
        </UDropdownMenu>
      </template>
    </TreeView>
    <OrgChart
      v-else
      v-model:collapsed="collapsed"
      :nodes="nodes"
      :label="t('dataviews.treeView.label')"
      :add-label="canCreate ? (node: TreeNode<TreeItem>) => t('dataviews.treeView.addChild', { name: node.data.title }) : undefined"
      :swatch="swatch"
      @open="(node: TreeNode<TreeItem>) => emit('edit', node.data.row)"
      @add-child="addChild"
    />
  </div>
</template>
