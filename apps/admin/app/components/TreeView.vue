<script setup lang="ts" generic="T">
/**
 * The one tree of the admin and the App (Admin_UI.md §5.9, T70) - the App menu's Organize, the
 * Design form's Structure, a TREE DataView: generic, it knows nothing of menus, widgets or tables. Each use
 * passes its nodes, renders a row's content in `#row` (and its buttons in `#actions`), decides what may go
 * where (`canDrop`) and saves a `move` its own way.
 *
 * - Rows: a chevron (a node with children, or `hasChildren` - loaded on `expand`), an optional drag handle,
 *   then the use's content. A `heading` node (a Design form's slot) is a label, not an item: never selected or
 *   dragged, a drop into it only.
 * - Dragging (native): over a row, its upper part is before it, its lower part after it; over a node that holds
 *   children, its middle is into it (at the end). Never into itself or a descendant: those rows dim, the cursor
 *   says no, and letting go over one emits `drop-refused`, for the use to say why. An outside drag (the
 *   Design form's palette) is taken too while `externalDragging` - `drop-external` says where.
 * - Keyboard (WAI-ARIA tree): ↑ ↓ Home End move, → opens or goes to the first child, ← closes or goes to the
 *   parent, Enter `activate`s, Space selects, Alt+↑ / Alt+↓ move the node among its siblings, F2 `rename`s.
 * - `filter`: only matching nodes and what leads to them, everything open.
 */
import type { DropdownMenuItem } from '@nuxt/ui'

export interface TreeNode<D> {
  id: string
  data: D
  /** Its children - undefined for a leaf. */
  children?: TreeNode<D>[]
  /** Children not loaded yet: a chevron, and `expand` when opened. */
  hasChildren?: boolean
  /** A label of the tree (a slot of a container), not an item. */
  heading?: boolean
  /** Can't be dragged (the tree's own `draggable` still applies). */
  fixed?: boolean
}
/** A node moved: its new parent and its index there, counted without it. */
export interface TreeMove { id: string, parent: string | null, index: number }

const props = withDefaults(defineProps<{
  nodes: TreeNode<T>[]
  /** The tree's accessible name. */
  label: string
  draggable?: boolean
  /** A grip at each row's start - else the whole row is the handle. */
  handle?: boolean
  multiple?: boolean
  /**
   * May `id` go into `parent` (null: the root) at `index` - a slot among the parent's current children, `id`
   * itself still counted? Its descendants are already refused. `id` is null for an outside drag.
   */
  canDrop?: (id: string | null, parent: string | null, index: number) => boolean
  /** Shown while set: matching nodes and their ancestors. */
  filter?: ((node: TreeNode<T>) => boolean) | null
  /** An outside drag (a palette) is under way - rows take it as a drop target. */
  externalDragging?: boolean
  /** Its context menu (a right click) - also what a phone opens with "⋮". */
  menu?: (node: TreeNode<T>) => DropdownMenuItem[][]
  /** Under an open container with nothing in it. */
  emptyText?: string
  /** A drop zone after the last row, while dragging - at the end of the root. */
  rootDropText?: string
  /** Pixels per level. */
  indent?: number
}>(), {
  draggable: false,
  handle: false,
  multiple: false,
  canDrop: undefined,
  filter: null,
  externalDragging: false,
  menu: undefined,
  emptyText: undefined,
  rootDropText: undefined,
  indent: 16
})
const emit = defineEmits<{
  'move': [move: TreeMove]
  'drop-external': [target: { parent: string | null, index: number }]
  'select': [id: string]
  'activate': [id: string]
  'rename': [id: string]
  'expand': [id: string, open: boolean]
  'drag-start': [id: string]
  'drag-end': []
  /** A node dropped on itself or one of its own descendants - refused; `onto` is the row it was over. */
  'drop-refused': [id: string, onto: string]
}>()
const collapsed = defineModel<string[]>('collapsed', { default: () => [] })
const selected = defineModel<string | string[] | null>('selected', { default: null })

defineSlots<{
  row(props: { node: TreeNode<T>, depth: number, open: boolean, selected: boolean }): unknown
  actions?(props: { node: TreeNode<T>, depth: number }): unknown
}>()

// --- The rows: the visible nodes, flattened, each with its parent and its index there ---------------------------

interface Row { node: TreeNode<T>, depth: number, parent: string | null, index: number, siblings: number }
const hasKids = (node: TreeNode<T>) => node.hasChildren === true || (node.children?.length ?? 0) > 0
const isContainer = (node: TreeNode<T>) => node.children !== undefined || node.hasChildren === true
function shows(node: TreeNode<T>): boolean {
  return !props.filter || props.filter(node) || (node.children ?? []).some(shows)
}
const isOpen = (node: TreeNode<T>) => !!props.filter || !collapsed.value.includes(node.id)
const rows = computed<Row[]>(() => {
  const out: Row[] = []
  const walk = (list: TreeNode<T>[], depth: number, parent: string | null) => {
    list.forEach((node, index) => {
      if (!shows(node)) return
      out.push({ node, depth, parent, index, siblings: list.length })
      if (node.children && isOpen(node)) walk(node.children, depth + 1, node.id)
    })
  }
  walk(props.nodes, 0, null)
  return out
})
const byId = computed(() => new Map(rows.value.map(r => [r.node.id, r])))
/** Empty open containers, for `emptyText`. */
const isEmptyOpen = (node: TreeNode<T>) => !!props.emptyText && node.children !== undefined && node.children.length === 0 && isOpen(node)

function toggle(node: TreeNode<T>, open = !isOpen(node)) {
  collapsed.value = open ? collapsed.value.filter(id => id !== node.id) : [...new Set([...collapsed.value, node.id])]
  emit('expand', node.id, open)
}

// --- Selecting ---------------------------------------------------------------------------------------------------

const isSelected = (id: string) => (Array.isArray(selected.value) ? selected.value.includes(id) : selected.value === id)
function select(node: TreeNode<T>, additive = false) {
  if (node.heading) return
  if (props.multiple) {
    const current = Array.isArray(selected.value) ? selected.value : []
    selected.value = additive ? (current.includes(node.id) ? current.filter(id => id !== node.id) : [...current, node.id]) : [node.id]
  } else {
    selected.value = node.id
  }
  emit('select', node.id)
}
// Selected from outside (a canvas click): its ancestors open, its row in view.
watch(() => (Array.isArray(selected.value) ? selected.value.at(-1) : selected.value), async (id) => {
  if (!id) return
  const ancestors: string[] = []
  const find = (list: TreeNode<T>[], path: string[]): boolean => list.some(n => n.id === id || (n.children ? find(n.children, [...path, n.id]) && (ancestors.push(...path, n.id), true) : false))
  find(props.nodes, [])
  if (ancestors.some(a => collapsed.value.includes(a))) collapsed.value = collapsed.value.filter(c => !ancestors.includes(c))
  focusedId.value = id
  await nextTick()
  rowElement(id)?.scrollIntoView({ block: 'nearest' })
})

// --- Keyboard (roving tabindex) ----------------------------------------------------------------------------------

const focusedId = ref<string | null>(null)
const tabStop = computed(() => (focusedId.value && byId.value.has(focusedId.value) ? focusedId.value : rows.value.find(r => !r.node.heading)?.node.id ?? null))
const root = ref<HTMLElement | null>(null)
const rowElement = (id: string) => root.value?.querySelector<HTMLElement>(`[data-tree-id="${CSS.escape(id)}"]`) ?? null
function focus(id: string | undefined) {
  if (!id) return
  focusedId.value = id
  void nextTick(() => rowElement(id)?.focus())
}
function onKeydown(event: KeyboardEvent, row: Row) {
  const list = rows.value
  const at = list.findIndex(r => r.node.id === row.node.id)
  const node = row.node
  if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    event.preventDefault()
    const up = event.key === 'ArrowUp'
    // canDrop takes the slot among its current siblings (itself counted); move, the index once it's out.
    const slot = row.index + (up ? -1 : 2)
    if (slot < 0 || slot > row.siblings || node.heading || node.fixed || !props.draggable) return
    if (props.canDrop && !props.canDrop(node.id, row.parent, slot)) return
    emit('move', { id: node.id, parent: row.parent, index: row.index + (up ? -1 : 1) })
    focus(node.id)
    return
  }
  const keys: Record<string, () => void> = {
    'ArrowDown': () => focus(list[at + 1]?.node.id),
    'ArrowUp': () => focus(list[at - 1]?.node.id),
    'Home': () => focus(list[0]?.node.id),
    'End': () => focus(list.at(-1)?.node.id),
    'ArrowRight': () => {
      if (hasKids(node) && !isOpen(node)) toggle(node, true)
      else if (node.children?.length) focus(list[at + 1]?.node.id)
    },
    'ArrowLeft': () => {
      if (hasKids(node) && isOpen(node) && !props.filter) toggle(node, false)
      else if (row.parent) focus(row.parent)
    },
    'Enter': () => {
      if (!node.heading) emit('activate', node.id)
    },
    ' ': () => select(node, event.ctrlKey || event.metaKey),
    'F2': () => {
      if (!node.heading) emit('rename', node.id)
    }
  }
  const action = keys[event.key]
  if (!action) return
  event.preventDefault()
  action()
}

/** A row is named by its content alone - not its chevron or its buttons. */
const uid = useId()
const labelId = (id: string) => `${uid}-${id}-label`

// --- Dragging ----------------------------------------------------------------------------------------------------

type Where = 'before' | 'after' | 'into'
const draggingId = ref<string | null>(null)
const over = ref<{ id: string, where: Where } | null>(null)
const dragActive = computed(() => draggingId.value !== null || props.externalDragging)
function isDescendant(ancestorId: string, id: string | null): boolean {
  if (!id) return false
  for (let row = byId.value.get(id); row; row = row.parent ? byId.value.get(row.parent) : undefined) {
    if (row.node.id === ancestorId) return true
  }
  return false
}
function allowed(parent: string | null, index: number): boolean {
  if (draggingId.value && (draggingId.value === parent || isDescendant(draggingId.value, parent))) return false
  return props.canDrop ? props.canDrop(draggingId.value, parent, index) : true
}
/** Where a drop over `row` lands, and whether it may. */
function targetOf(row: Row, where: Where): { parent: string | null, index: number } {
  if (where === 'into') return { parent: row.node.id, index: row.node.children?.length ?? 0 }
  // Moving down within the same list: the slot after its own place counts it out.
  return { parent: row.parent, index: row.index + (where === 'after' ? 1 : 0) }
}
function whereFor(event: DragEvent, row: Row): Where | null {
  if (!dragActive.value || draggingId.value === row.node.id) return null
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const y = (event.clientY - box.top) / box.height
  const candidates: Where[] = row.node.heading
    ? ['into']
    : isContainer(row.node)
      ? (y < 0.3 ? ['before', 'into'] : y > 0.7 && !isOpen(row.node) ? ['after', 'into'] : ['into', y < 0.5 ? 'before' : 'after'])
      : [y < 0.5 ? 'before' : 'after']
  return candidates.find((where) => {
    const target = targetOf(row, where)
    return allowed(target.parent, target.index)
  }) ?? null
}
function onDragStart(event: DragEvent, row: Row) {
  if (!props.draggable || row.node.heading || row.node.fixed) return event.preventDefault()
  draggingId.value = row.node.id
  event.dataTransfer?.setData('text/plain', row.node.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  emit('drag-start', row.node.id)
}
/** The node itself or one of its descendants - no drop there, the cursor says so. */
const isRefused = (id: string) => !!draggingId.value && (draggingId.value === id || isDescendant(draggingId.value, id))
function onDragEnd(event?: DragEvent) {
  // Let go over one of its own descendants (no drop happened): say why, rather than nothing. Where it was let go is
  // read from the pointer - the browser's last dragleave has already gone by.
  if (event && draggingId.value && event.dataTransfer?.dropEffect === 'none') {
    const onto = (document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-tree-id]') as HTMLElement | null)?.dataset.treeId
    if (onto && onto !== draggingId.value && isRefused(onto)) emit('drop-refused', draggingId.value, onto)
  }
  draggingId.value = null
  over.value = null
  emit('drag-end')
}
function onDragOver(event: DragEvent, row: Row) {
  if (isRefused(row.node.id)) {
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
    over.value = null
    return
  }
  const where = whereFor(event, row)
  if (!where) {
    if (over.value?.id === row.node.id) over.value = null
    return
  }
  event.preventDefault()
  over.value = { id: row.node.id, where }
}
function onDrop(row: Row) {
  const where = over.value?.id === row.node.id ? over.value.where : null
  if (where) finish(targetOf(row, where))
  else onDragEnd()
}
function onDragLeave(id: string) {
  if (over.value?.id === id) over.value = null
}
function onRootDragOver(event: DragEvent) {
  if (!dragActive.value || !allowed(null, props.nodes.length)) return
  event.preventDefault()
  over.value = { id: '', where: 'into' }
}
function finish(target: { parent: string | null, index: number }) {
  const id = draggingId.value
  if (id) {
    // Within the same list, the index counted it; once out, everything after it moves up by one.
    const from = byId.value.get(id)
    const index = from && from.parent === target.parent && from.index < target.index ? target.index - 1 : target.index
    if (!(from && from.parent === target.parent && from.index === index)) emit('move', { id, parent: target.parent, index })
  } else if (props.externalDragging) {
    emit('drop-external', target)
  }
  onDragEnd()
}
const lineAt = (id: string) => (over.value?.id === id && over.value.where !== 'into' ? over.value.where : null)
const into = (id: string) => over.value?.id === id && over.value.where === 'into'
</script>

<template>
  <div
    ref="root"
    role="tree"
    :aria-label="label"
    :aria-multiselectable="multiple || undefined"
    class="flex flex-col text-sm"
  >
    <template
      v-for="row in rows"
      :key="row.node.id"
    >
      <UContextMenu
        :items="menu && !row.node.heading ? menu(row.node) : []"
        :disabled="!menu || row.node.heading"
      >
        <div
          role="treeitem"
          :data-tree-id="row.node.id"
          :aria-labelledby="labelId(row.node.id)"
          :aria-level="row.depth + 1"
          :aria-expanded="hasKids(row.node) ? isOpen(row.node) : undefined"
          :aria-selected="row.node.heading ? undefined : isSelected(row.node.id)"
          :aria-setsize="row.siblings"
          :aria-posinset="row.index + 1"
          :tabindex="tabStop === row.node.id ? 0 : -1"
          :draggable="draggable && !row.node.heading && !row.node.fixed && !handle"
          class="group relative flex items-center gap-1.5 rounded-md py-1 pe-1 outline-none focus-visible:ring-2 focus-visible:ring-primary"
          :class="[
            row.node.heading ? 'text-xs text-muted' : 'cursor-pointer',
            !row.node.heading && isSelected(row.node.id) ? 'bg-primary/10 text-highlighted' : row.node.heading ? '' : 'hover:bg-elevated',
            into(row.node.id) ? 'bg-primary/10 ring-1 ring-primary ring-inset' : '',
            draggingId === row.node.id ? 'opacity-40' : isRefused(row.node.id) ? 'cursor-not-allowed opacity-50' : ''
          ]"
          :style="{ paddingInlineStart: `${row.depth * indent + 4}px` }"
          @click="select(row.node, $event.ctrlKey || $event.metaKey)"
          @focus="focusedId = row.node.id"
          @keydown="onKeydown($event, row)"
          @dragstart="onDragStart($event, row)"
          @dragend="onDragEnd($event)"
          @dragover="onDragOver($event, row)"
          @dragleave="onDragLeave(row.node.id)"
          @drop.prevent="onDrop(row)"
        >
          <!-- Where a drop lands: a line before or after it. -->
          <span
            v-if="lineAt(row.node.id)"
            class="pointer-events-none absolute inset-x-0 h-0.5 rounded bg-primary"
            :class="lineAt(row.node.id) === 'before' ? 'top-0' : 'bottom-0'"
          />
          <UIcon
            v-if="handle && draggable && !row.node.heading"
            name="i-lucide-grip-vertical"
            class="size-4 shrink-0 cursor-grab text-dimmed"
            :class="row.node.fixed ? 'invisible' : ''"
            :draggable="!row.node.fixed"
            @dragstart.stop="onDragStart($event, row)"
          />
          <button
            v-if="hasKids(row.node)"
            type="button"
            tabindex="-1"
            class="flex size-4 shrink-0 items-center justify-center text-muted"
            :aria-label="isOpen(row.node) ? $t('common.collapse') : $t('common.expand')"
            @click.stop="toggle(row.node)"
          >
            <UIcon
              :name="isOpen(row.node) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
              class="size-3.5"
            />
          </button>
          <span
            v-else
            class="w-4 shrink-0"
          />
          <div
            :id="labelId(row.node.id)"
            class="flex min-w-0 flex-1 items-center gap-1.5"
          >
            <slot
              name="row"
              :node="row.node"
              :depth="row.depth"
              :open="isOpen(row.node)"
              :selected="isSelected(row.node.id)"
            />
          </div>
          <span
            v-if="$slots.actions"
            class="flex shrink-0 items-center gap-1"
            @click.stop
          >
            <slot
              name="actions"
              :node="row.node"
              :depth="row.depth"
            />
          </span>
        </div>
      </UContextMenu>
      <p
        v-if="isEmptyOpen(row.node)"
        class="py-0.5 text-xs text-dimmed"
        :style="{ paddingInlineStart: `${(row.depth + 1) * indent + 26}px` }"
      >
        {{ emptyText }}
      </p>
    </template>
    <!-- Always in the layout while a root drop exists, shown only while dragging, so starting a drag moves nothing. -->
    <div
      v-if="rootDropText"
      class="mt-1 rounded-md border border-dashed px-2 py-1 text-xs text-muted"
      :class="[over?.id === '' ? 'border-primary text-primary' : 'border-default', dragActive ? '' : 'invisible']"
      @dragover="onRootDragOver"
      @dragleave="over?.id === '' && (over = null)"
      @drop.prevent="finish({ parent: null, index: nodes.length })"
    >
      {{ rootDropText }}
    </div>
  </div>
</template>
