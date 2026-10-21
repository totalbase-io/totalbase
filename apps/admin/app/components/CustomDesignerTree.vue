<script setup lang="ts">
/**
 * The Design form's Structure tab (DataViews.md §12.4): the page's widgets as a tree - the page
 * (and a CUSTOM page's header and footer), each container's slots as a level of their own (a Card's header,
 * body and footer, a Tab's panes), overlays even while closed. Each row: its type's icon and its Name - or its
 * type and what tells it apart ("Form field · apellido") - then what it carries: a Visible formula (an
 * eye, the formula on hover), other formulas (ƒ), events wired (a bolt), a configuration the catalog refuses
 * (a red dot).
 *
 * The same canvas state as the canvas (useCustomCanvasContext): a click selects - canvas, inspector and tree
 * follow each other; a drag reorders or moves into another container or slot (refused where the canvas
 * refuses it, and said so); a container's or a slot's "+" places a widget of the catalog there; the "⋮" (and
 * a right click): Rename (F2), Duplicate, Move up and down (Alt+arrows), Wrap in a Card or a Box, Open in the
 * canvas for an overlay, Delete. A search with filters: hidden, with a formula, with an error.
 */
import {
  itemSlot,
  PAGE_FOOTER_SLOT,
  PAGE_HEADER_SLOT,
  validateWidgetControlConfig,
  WIDGET_CATALOG,
  widgetDefinition,
  type WidgetName
} from '@totalbase/tb-catalog'
import type { DataViewField, DataViewType } from '~/types/dataview'
import { CUSTOM_CANVAS_CONTEXT_KEY, hiddenRule, widgetMenu } from '~/composables/useCustomCanvasContext'
import { areaWidgets, fieldById } from '~/utils/widget-layout'
import { OVERLAY_WIDGETS } from '~/utils/widget-components'
import { CUSTOM_DESIGNER_TREE_KEY, type TreeAreaNode, type TreeWidgetNode } from '~/composables/useCustomDesignerTree'
import type { TreeMove, TreeNode } from '~/components/TreeView.vue'
import CustomDesignerTreeAdd from '~/components/CustomDesignerTreeAdd.vue'
import CustomDesignerTreeFacts from '~/components/CustomDesignerTreeFacts.vue'

const props = defineProps<{ viewType: DataViewType }>()
const emit = defineEmits<{ selected: [id: string] }>()

const ctx = inject(CUSTOM_CANVAS_CONTEXT_KEY)!
const { t } = useI18n()
const cat = useDesignerCatalogText()

// --- What each widget carries ---------------------------------------------------

type Binding = { kind?: string, formula?: string }
interface Facts {
  hidden: string | false | null
  formulas: string[]
  events: string[]
  errors: string[]
}
const facts = computed(() => new Map(ctx.fields.value.map((field): [string, Facts] => {
  const config = field.config as { props?: Record<string, unknown>, bindings?: Record<string, Binding>, emits?: Record<string, string>, slot?: string }
  const bindings = config.bindings ?? {}
  return [field.id, {
    hidden: hiddenRule(field),
    formulas: Object.entries(bindings).filter(([prop, b]) => prop !== 'visible' && b.kind === 'formula').map(([prop]) => prop),
    events: Object.keys(config.emits ?? {}),
    errors: field.widget ? validateWidgetControlConfig({ widget: field.widget, props: config.props ?? {}, bindings, emits: config.emits ?? {} }) : []
  }]
})))

function typeLabel(field: DataViewField): string {
  return cat.widgetLabel(field.widget ?? '', WIDGET_CATALOG[field.widget as WidgetName]?.label ?? field.widget ?? '')
}
/** What tells an unnamed widget apart: its column, its label or title, its text. */
function hint(field: DataViewField): string {
  const p = (field.config as { props?: Record<string, unknown> }).props ?? {}
  for (const key of ['column', 'label', 'title', 'text', 'description']) {
    if (typeof p[key] === 'string' && p[key]) return String(p[key])
  }
  return ''
}
function rowTitle(field: DataViewField): string {
  if (field.label) return field.label
  const h = hint(field)
  return h ? `${typeLabel(field)} · ${h}` : typeLabel(field)
}

// --- The tree, as the shared one takes it (TreeView.vue) ---------------------------------------------------------
// An area (the page, a slot of a container) is a heading; a widget holds its slots - or, with one slot (a Form's
// fields, a form field's input), that slot's widgets right under it, no level of its own.

type AreaNode = TreeAreaNode
type WidgetNode = TreeWidgetNode
type AreaData = { kind: 'area', node: AreaNode }
type WidgetData = { kind: 'widget', node: WidgetNode }
type Data = AreaData | WidgetData

function areaNode(parent: string | null, slot: string | undefined, label: string): AreaNode {
  return {
    kind: 'area',
    key: `${parent ?? 'page'}:${slot ?? ''}`,
    label,
    area: { parent, slot },
    children: areaWidgets(ctx.fields.value, parent, slot).map(widgetNode)
  }
}
function widgetNode(field: DataViewField): WidgetNode {
  const definition = widgetDefinition(field.widget as WidgetName)
  const items = ((field.config as { props?: { items?: unknown } }).props?.items ?? []) as { label?: string }[]
  const areas: AreaNode[] = []
  for (const [slot, meta] of Object.entries(definition.slots)) {
    const label = cat.slotLabel(field.widget ?? '', slot, meta.label)
    if (meta.perItem) {
      (Array.isArray(items) ? items : []).forEach((item, index) => areas.push(areaNode(field.id, itemSlot(slot, item, index), `${label} · ${item.label ?? index + 1}`)))
    } else {
      areas.push(areaNode(field.id, slot, label))
    }
  }
  return { kind: 'widget', key: field.id, field, areas, flat: areas.length === 1 }
}
const roots = computed<AreaNode[]>(() => props.viewType === 'CUSTOM'
  ? [
      areaNode(null, PAGE_HEADER_SLOT, t('designer.customDesignerTree.pageHeader')),
      areaNode(null, undefined, t('designer.customDesignerTree.page')),
      areaNode(null, PAGE_FOOTER_SLOT, t('designer.customDesignerTree.pageFooter'))
    ]
  : [areaNode(null, undefined, t('designer.customDesignerTree.page'))])

function toTreeArea(area: AreaNode): TreeNode<Data> {
  return { id: area.key, heading: true, data: { kind: 'area', node: area }, children: area.children.map(toTreeWidget) }
}
function toTreeWidget(widget: WidgetNode): TreeNode<Data> {
  const children = widget.areas.length === 0 ? undefined : widget.flat ? widget.areas[0]!.children.map(toTreeWidget) : widget.areas.map(toTreeArea)
  return { id: widget.key, data: { kind: 'widget', node: widget }, children, fixed: !ctx.editable.value }
}
const treeNodes = computed(() => roots.value.map(toTreeArea))
const dataOf = (node: TreeNode<unknown>) => node.data as Data
const fieldOf = (node: TreeNode<unknown>) => (node.data as WidgetData).node.field

/** The area a tree parent stands for: a heading's own, a one-slot widget's slot. */
function areaOf(parentId: string | null): AreaNode | null {
  if (!parentId) return null
  const find = (areas: AreaNode[]): AreaNode | null => {
    for (const area of areas) {
      if (area.key === parentId) return area
      for (const widget of area.children) {
        if (widget.key === parentId) return widget.flat ? widget.areas[0]! : null
        const inner = find(widget.areas)
        if (inner) return inner
      }
    }
    return null
  }
  return find(roots.value)
}

// --- Search and filters ---------------------------------------------------------------

const search = ref('')
const filters = ref<('hidden' | 'formula' | 'error')[]>([])
const filtering = computed(() => search.value.trim() !== '' || filters.value.length > 0)
function matches(field: DataViewField): boolean {
  const f = facts.value.get(field.id)!
  const q = search.value.trim().toLowerCase()
  if (q && ![field.label ?? '', typeLabel(field), field.widget ?? '', hint(field)].some(text => text.toLowerCase().includes(q))) return false
  if (filters.value.includes('hidden') && f.hidden === null) return false
  if (filters.value.includes('formula') && f.formulas.length === 0 && typeof f.hidden !== 'string') return false
  if (filters.value.includes('error') && f.errors.length === 0) return false
  return true
}
const treeFilter = computed(() => (filtering.value ? (node: TreeNode<unknown>) => dataOf(node).kind === 'widget' && matches(fieldOf(node)) : null))
const filterItems = computed(() => [[
  { type: 'label' as const, label: t('designer.customDesignerTree.show') },
  ...(['hidden', 'formula', 'error'] as const).map(key => ({
    label: t(`designer.customDesignerTree.filter.${key}`),
    type: 'checkbox' as const,
    checked: filters.value.includes(key),
    onUpdateChecked: (on: boolean) => {
      filters.value = on ? [...filters.value, key] : filters.value.filter(k => k !== key)
    }
  }))
]])

const collapsed = ref<string[]>([])

// --- Selecting: the canvas, the inspector and the tree follow each other ---------------------------------------

const selected = computed<string | string[] | null>({
  get: () => ctx.selectedId.value,
  set: (id) => {
    if (typeof id === 'string') select(id)
  }
})
function select(id: string) {
  ctx.selectedId.value = id
  emit('selected', id)
}

// --- Moving: a drag (the tree's or the palette's) or Alt+arrows -------------------------------------------------

/** May what's dragged (or `id`, by keyboard) go into the parent's area? The canvas's own rule. */
function canDrop(id: string | null, parentId: string | null): boolean {
  const area = areaOf(parentId)
  if (!area) return false
  if (!ctx.drag.value && id) {
    ctx.drag.value = { kind: 'move', id }
    try {
      return ctx.canDrop(area.area)
    } finally {
      ctx.drag.value = null
    }
  }
  return ctx.canDrop(area.area)
}
function onMove(move: TreeMove) {
  const area = areaOf(move.parent)
  const field = fieldById(ctx.fields.value, move.id)
  if (!area || !field) return
  // TreeView counts the index without it; the canvas, with it still in its place.
  const from = area.children.findIndex(w => w.key === move.id)
  ctx.move(move.id, { ...area.area, index: from >= 0 && move.index >= from ? move.index + 1 : move.index })
}
function onDropExternal(target: { parent: string | null, index: number }) {
  const area = areaOf(target.parent)
  if (area) ctx.drop({ ...area.area, index: target.index })
}

// --- Adding (a container's or a slot's "+") ----------------------------------------------------------------------

const adding = ref<string | null>(null)
function placeIn(area: AreaNode, widget: WidgetName) {
  adding.value = null
  ctx.place(widget, { ...area.area, index: area.children.length })
}

// --- Menu ---------------------------------------------------------------------------------

function menuOf(field: DataViewField) {
  const items = widgetMenu(ctx, field)
  const definition = widgetDefinition(field.widget as WidgetName)
  const own = Object.values(definition.slots).some(slot => slot.canvas === 'own')
  if (!own) return items
  return [[{ label: t('designer.customDesignerTree.openInCanvas'), icon: 'i-lucide-square-arrow-out-up-right', onSelect: () => ctx.enter(field.id, 'own') }], ...items]
}
const treeMenu = (node: TreeNode<unknown>) => (dataOf(node).kind === 'widget' ? menuOf(fieldOf(node)) : [])
const isOverlay = (field: DataViewField) => OVERLAY_WIDGETS.includes(field.widget as WidgetName)

provide(CUSTOM_DESIGNER_TREE_KEY, { adding, placeIn })
</script>

<template>
  <div class="flex w-full min-w-0 flex-col gap-2">
    <div class="flex items-center gap-1">
      <UInput
        v-model="search"
        :aria-label="t('designer.customDesignerTree.search')"
        icon="i-lucide-search"
        :placeholder="t('designer.customDesignerTree.search')"
        size="sm"
        class="min-w-0 flex-1"
      />
      <UDropdownMenu :items="filterItems">
        <UButton
          icon="i-lucide-filter"
          :color="filters.length ? 'primary' : 'neutral'"
          :variant="filters.length ? 'soft' : 'ghost'"
          size="sm"
          :aria-label="t('designer.customDesignerTree.filters')"
        />
      </UDropdownMenu>
    </div>
    <TreeView
      v-model:collapsed="collapsed"
      v-model:selected="selected"
      :nodes="treeNodes"
      :label="t('designer.customDesignerTree.title')"
      :draggable="ctx.editable.value"
      :can-drop="canDrop"
      :filter="treeFilter"
      :external-dragging="ctx.drag.value?.kind === 'new'"
      :menu="treeMenu"
      :empty-text="t('designer.customDesignerTree.empty')"
      :indent="14"
      @move="onMove"
      @drop-external="onDropExternal"
      @activate="select"
      @rename="(id: string) => ctx.rename(id)"
      @drag-start="(id: string) => (ctx.drag.value = { kind: 'move', id })"
      @drag-end="ctx.drag.value = null"
    >
      <template #row="{ node }">
        <template v-if="dataOf(node).kind === 'area'">
          <span class="truncate text-xs font-medium tracking-wide text-muted uppercase">{{ (dataOf(node) as AreaData).node.label }}</span>
        </template>
        <template v-else>
          <UIcon
            :name="WIDGET_CATALOG[fieldOf(node).widget as WidgetName]?.icon ?? 'i-lucide-square'"
            class="size-4 shrink-0 text-muted"
          />
          <span
            class="min-w-0 truncate"
            :class="fieldOf(node).label ? 'font-mono text-xs' : undefined"
          >{{ rowTitle(fieldOf(node)) }}</span>
          <UBadge
            v-if="isOverlay(fieldOf(node))"
            :label="t('designer.customDesignerTree.overlay')"
            color="neutral"
            variant="subtle"
            size="sm"
            class="shrink-0"
          />
        </template>
      </template>
      <template #actions="{ node }">
        <CustomDesignerTreeAdd
          v-if="dataOf(node).kind === 'area'"
          :node="(dataOf(node) as AreaData).node"
        />
        <span
          v-else
          class="flex items-center gap-1 text-muted"
        >
          <CustomDesignerTreeFacts :facts="facts.get(fieldOf(node).id)!" />
          <CustomDesignerTreeAdd
            v-if="(dataOf(node) as WidgetData).node.flat"
            :node="(dataOf(node) as WidgetData).node.areas[0]!"
          />
          <UDropdownMenu :items="menuOf(fieldOf(node))">
            <UButton
              icon="i-lucide-ellipsis-vertical"
              color="neutral"
              variant="ghost"
              size="xs"
              class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              :aria-label="t('designer.customDesignerTree.actions')"
            />
          </UDropdownMenu>
        </span>
      </template>
    </TreeView>
  </div>
</template>
