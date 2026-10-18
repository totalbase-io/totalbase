<script setup lang="ts">
/**
 * One area on a CUSTOM page's canvas (Specification_DataViews.md §12.2)
 * - the page, or one slot of a widget - drawn in flow as the
 * App draws it (a 12-column grid, rows as tall as their content), with its
 * widgets as canvas items. It takes drops: a line shows where the widget
 * lands; the innermost area under the pointer wins.
 */
import { CUSTOM_CANVAS_CONTEXT_KEY, isAreaTarget } from '~/composables/useCustomCanvasContext'
import { areaWidgets, dropIndex, widgetCellStyle } from '~/utils/widget-layout'
import CustomCanvasItem from '~/components/CustomCanvasItem.vue'

const props = defineProps<{
  parent: string | null
  slotName?: string
  /** The slot's name, shown while the area is empty. */
  label?: string
  /** In a row at the right, each as wide as it is - the page header's buttons, as the App draws them. */
  inline?: boolean
}>()

const ctx = inject(CUSTOM_CANVAS_CONTEXT_KEY)!
const { t } = useI18n()
const area = computed(() => ({ parent: props.parent, slot: props.slotName }))
const widgets = computed(() => areaWidgets(ctx.fields.value, props.parent, props.slotName))
const target = computed(() => (isAreaTarget(ctx.dropTarget.value, area.value) ? ctx.dropTarget.value : null))
const el = ref<HTMLElement | null>(null)

/** A widget's top and bottom edges belong to this area - before or after it, not into it. */
const EDGE_PX = 8

function itemBoxes(): DOMRect[] {
  return Array.from(el.value?.querySelectorAll<HTMLElement>(':scope > [data-canvas-item]') ?? []).map(item => item.getBoundingClientRect())
}
function claim(event: DragEvent, index: number) {
  event.preventDefault()
  event.stopPropagation()
  if (event.dataTransfer) event.dataTransfer.dropEffect = ctx.drag.value?.kind === 'new' ? 'copy' : 'move'
  if (target.value?.index !== index) ctx.dropTarget.value = { ...area.value, index }
}
/** Capture, before any area inside: over a widget's edge, the drop is this area's - so a container filled by its own area can still be dropped before or after. */
function onDragOverEdge(event: DragEvent) {
  if (!ctx.drag.value || !ctx.canDrop(area.value)) return
  const { clientX: x, clientY: y } = event
  const boxes = itemBoxes()
  const hit = boxes.findIndex(b => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom && (y - b.top < EDGE_PX || b.bottom - y < EDGE_PX))
  if (hit !== -1) claim(event, y - boxes[hit]!.top < EDGE_PX ? hit : hit + 1)
}
function onDragOver(event: DragEvent) {
  if (!ctx.drag.value || !ctx.canDrop(area.value)) return
  claim(event, dropIndex(itemBoxes(), event.clientX, event.clientY))
}
function onDragLeave(event: DragEvent) {
  if (target.value && !el.value?.contains(event.relatedTarget as Node | null)) ctx.dropTarget.value = null
}
/** Capture: the area the last dragover chose takes the drop, whichever element is under the pointer. */
function onDrop(event: DragEvent) {
  if (!target.value) return
  event.preventDefault()
  event.stopPropagation()
  ctx.drop(target.value)
}
</script>

<template>
  <div
    ref="el"
    class="w-full min-w-0 gap-3 rounded-md"
    :class="[
      // content-start: an area taller than its rows (a Splitter's panel) keeps them their own height, at its top.
      inline ? 'flex flex-wrap items-center justify-end' : 'widget-area grid grid-cols-12 content-start',
      widgets.length === 0 ? ['min-h-12 border border-dashed p-2', target ? 'border-primary bg-primary/5' : 'border-accented'] : undefined
    ]"
    @dragover.capture="onDragOverEdge"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop.capture="onDrop"
  >
    <CustomCanvasItem
      v-for="(child, index) in widgets"
      :key="child.id"
      :field="child"
      :drop-before="target?.index === index"
      :drop-after="index === widgets.length - 1 && target?.index === widgets.length"
      :style="inline ? undefined : widgetCellStyle(child)"
    />
    <p
      v-if="widgets.length === 0"
      class="col-span-12 flex flex-1 items-center justify-center text-xs text-dimmed"
    >
      {{ label ? t('designer.customCanvasArea.dropHereIn', { label }) : t('designer.customCanvasArea.dropHere') }}
    </p>
  </div>
</template>
