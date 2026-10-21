<script setup lang="ts">
/**
 * One placed widget on a CUSTOM page's canvas (DataViews.md §12.3): the real
 * widget, drawn by WidgetRenderer in design mode - its inline slots are
 * canvas areas again - wrapped with what editing needs: a click selects
 * (the widget itself doesn't react), a drag moves it, the right edge sets
 * its width in columns, the bottom edge a sizable widget's height in rows.
 *
 * A widget edited in its own canvas (a Modal, a Slideover) is a compact
 * block with Open; a widget with some own-canvas slots (a Popover's
 * content) shows the widget and one Open per such slot.
 *
 * Selected, it shows Focus (an inline container) and a "⋮": its width in
 * columns (desktop), Duplicate, Delete.
 */
import { widgetDefinition, type WidgetName } from '@totalbase/tb-catalog'
import type { DataViewField } from '~/types/dataview'
import { CUSTOM_CANVAS_CONTEXT_KEY, hiddenRule, widgetMenu } from '~/composables/useCustomCanvasContext'
import { areaWidgets, childWidgets, DEFAULT_SIZABLE_ROWS, LAYOUT_ROW_PX, SIZABLE_ROWS } from '~/utils/widget-layout'
import WidgetRenderer from '~/components/WidgetRenderer.vue'
import { OVERLAY_WIDGETS } from '~/utils/widget-components'

const props = defineProps<{
  field: DataViewField
  /** A drop lands right before this widget / right after it (the area's last). */
  dropBefore?: boolean
  dropAfter?: boolean
}>()

const ctx = inject(CUSTOM_CANVAS_CONTEXT_KEY)!
const { t } = useI18n()
const cat = useDesignerCatalogText()
const el = ref<HTMLElement | null>(null)
const definition = computed(() => widgetDefinition(props.field.widget as WidgetName))
const definitionLabel = computed(() => cat.widgetLabel(props.field.widget ?? '', definition.value.label))
const selected = computed(() => ctx.selectedId.value === props.field.id)
const slots = computed(() => Object.entries(definition.value.slots))
const ownSlots = computed(() => slots.value.filter(([, slot]) => slot.canvas === 'own'))
/** An overlay (a Modal, a Slideover) - every slot edited apart: drawn as a block, not as the widget (it isn't on the page until opened). A Table's Empty is edited apart too, but the Table is on the page. */
const isBlock = computed(() => OVERLAY_WIDGETS.includes(props.field.widget as WidgetName) && ownSlots.value.length > 0 && ownSlots.value.length === slots.value.length)
const hasInlineSlots = computed(() => ownSlots.value.length < slots.value.length)
const childCount = computed(() => childWidgets(ctx.fields.value, props.field.id).length)
const ownSlotCount = (slot: string) => areaWidgets(ctx.fields.value, props.field.id, slot).length

const menuItems = computed(() => widgetMenu(ctx, props.field))
/** Hidden by its Visible formula (or Visible off): faded, dashed and labeled - unless the toolbar shows it as the App would. */
const hidden = computed(() => hiddenRule(props.field))
const markedHidden = computed(() => ctx.markHidden.value && hidden.value !== null)
/** The variable a widget's rows or options come from - its tag says "Table · alicuotasIva" when it has no name. */
const boundTo = computed(() => {
  const bindings = (props.field.config as { bindings?: Record<string, { kind?: string, variable?: string }> }).bindings ?? {}
  const source = bindings.data ?? bindings.items
  return source?.kind === 'variable' ? source.variable : undefined
})

// --- Select --------------------------------------------------------------------

/**
 * The tag and the actions sit above the widget - unless a scrolling
 * container (a Splitter's panel, a Card's Fill-height body) would clip them
 * there: a widget at its top edge gets them inside its own top edge.
 */
const CHROME_HEIGHT = 24
const chromeInside = ref(false)
function clippingAncestor(node: HTMLElement): HTMLElement | null {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent)
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY + style.overflow)) return parent
  }
  return null
}
function placeChrome() {
  const node = el.value
  if (!node) return
  const clip = clippingAncestor(node)
  if (!clip) {
    chromeInside.value = false
    return
  }
  chromeInside.value = node.getBoundingClientRect().top - clip.getBoundingClientRect().top < CHROME_HEIGHT
}
watch(selected, (isSelected) => {
  if (isSelected) void nextTick(placeChrome)
}, { immediate: true })

/** A click selects the innermost widget under it - and never reaches the widget (no button press, no popover opening). A tab still switches. */
function onClickCapture(event: MouseEvent) {
  const target = event.target as HTMLElement
  if (target.closest('[data-canvas-item]') !== el.value || target.closest('[data-canvas-chrome]')) return
  ctx.selectedId.value = props.field.id
  if (target.closest('[role="tab"]')) return
  event.preventDefault()
  event.stopPropagation()
}
function onDblClick(event: MouseEvent) {
  if ((event.target as HTMLElement).closest('[data-canvas-item]') !== el.value) return
  if (ownSlots.value.length > 0) ctx.enter(props.field.id, 'own')
  else if (hasInlineSlots.value) ctx.enter(props.field.id, 'focus')
}

// --- Drag ----------------------------------------------------------------------

function onDragStart(event: DragEvent) {
  event.stopPropagation()
  if (resizing.value) return event.preventDefault()
  ctx.drag.value = { kind: 'move', id: props.field.id }
  ctx.selectedId.value = props.field.id
  event.dataTransfer?.setData('text/plain', props.field.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}
function onDragEnd() {
  ctx.drag.value = null
  ctx.dropTarget.value = null
}
/** Dragging over a tab opens its content, to drop into it (reka's tabs switch on mousedown). */
function onDragOverTab(event: DragEvent) {
  const tab = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"]')
  if (!tab || tab.closest('[data-canvas-item]') !== el.value || tab.dataset.state === 'active') return
  tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
}

// --- Resize --------------------------------------------------------------------

/** Whose height the bottom edge sets: a sizable widget's own - or, on a Form field, its input's when that one is sizable (a Textarea), so the field sizes like what it holds. */
const heightTarget = computed<DataViewField | null>(() => {
  if (definition.value.sizable) return props.field
  const inputSlots = slots.value.filter(([, slot]) => slot.holds === 'input').map(([name]) => name)
  if (inputSlots.length === 0) return null
  const input = ctx.fields.value.find(f => f.parent === props.field.id && inputSlots.includes((f.config as { slot?: string }).slot ?? 'default'))
  return input?.widget && widgetDefinition(input.widget as WidgetName).sizable ? input : null
})
const rows = computed(() => {
  const gridH = heightTarget.value?.gridH ?? 0
  return gridH > 1 ? gridH : DEFAULT_SIZABLE_ROWS
})
const resizing = ref<{ axis: 'x' | 'y', start: number, from: number, unit: number } | null>(null)
function startResize(axis: 'x' | 'y', event: PointerEvent) {
  event.preventDefault()
  event.stopPropagation()
  const areaWidth = el.value?.parentElement?.clientWidth ?? 0
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  resizing.value = axis === 'x'
    ? { axis, start: event.clientX, from: props.field.gridW || 12, unit: (areaWidth + 12) / 12 } // 12px: the area's gap
    : { axis, start: event.clientY, from: rows.value, unit: LAYOUT_ROW_PX }
}
function resizedValue(event: PointerEvent): number {
  const r = resizing.value!
  const next = Math.round(r.from + ((r.axis === 'x' ? event.clientX : event.clientY) - r.start) / r.unit)
  return r.axis === 'x' ? Math.min(12, Math.max(1, next)) : Math.min(SIZABLE_ROWS.max, Math.max(SIZABLE_ROWS.min, next))
}
function onResizeMove(event: PointerEvent) {
  if (!resizing.value) return
  const value = resizedValue(event)
  if (resizing.value.axis === 'x' && value !== props.field.gridW) ctx.resize(props.field.id, { gridW: value }, false)
  if (resizing.value.axis === 'y' && heightTarget.value && value !== heightTarget.value.gridH) ctx.resize(heightTarget.value.id, { gridH: value }, false)
}
function endResize(event: PointerEvent) {
  if (!resizing.value) return
  const value = resizedValue(event)
  if (resizing.value.axis === 'x') ctx.resize(props.field.id, { gridW: value }, true)
  else if (heightTarget.value) ctx.resize(heightTarget.value.id, { gridH: value }, true)
  resizing.value = null
}
</script>

<template>
  <div
    ref="el"
    :data-canvas-item="field.id"
    class="canvas-item relative min-w-0 rounded-sm"
    :class="[selected ? undefined : 'canvas-item-hover', ctx.drag.value?.kind === 'move' && ctx.drag.value.id === field.id ? 'opacity-40' : undefined]"
    :draggable="ctx.editable.value && !resizing"
    @click.capture="onClickCapture"
    @dblclick="onDblClick"
    @dragstart="onDragStart"
    @dragend="onDragEnd"
    @dragover.capture="onDragOverTab"
  >
    <!-- A Modal or a Slideover: a block where it lives, opened to edit what it holds. -->
    <div
      v-if="isBlock"
      class="flex items-center gap-2 rounded-md border border-dashed border-accented bg-elevated/50 px-3 py-2 text-sm"
    >
      <UIcon
        :name="definition.icon"
        class="size-4 shrink-0 text-muted"
      />
      <span class="font-medium text-highlighted">{{ definitionLabel }}</span>
      <span
        v-if="field.label"
        class="truncate font-mono text-xs text-muted"
      >{{ field.label }}</span>
      <span class="text-xs text-muted">· {{ t('designer.customCanvasItem.widgetCount', childCount) }}</span>
      <UButton
        :label="t('common.open')"
        icon="i-lucide-square-arrow-out-up-right"
        size="xs"
        color="neutral"
        variant="outline"
        class="ms-auto"
        data-canvas-chrome
        @click="ctx.enter(field.id, 'own')"
      />
    </div>
    <template v-else>
      <div
        data-canvas-widget
        :class="markedHidden ? 'opacity-50' : undefined"
      >
        <WidgetRenderer :field="field" />
      </div>
      <template v-if="markedHidden">
        <span class="pointer-events-none absolute inset-0 rounded-sm border border-dashed border-accented" />
        <UTooltip
          :text="hidden === false ? t('designer.customCanvasItem.hiddenOff') : String(hidden)"
          :content="{ side: 'top' }"
        >
          <span
            data-canvas-chrome
            class="absolute right-1 bottom-1 z-[4] rounded-sm bg-elevated px-1 text-[10px] leading-4 text-muted ring ring-default"
          >{{ hidden === false ? t('designer.customCanvasItem.hiddenOffTag') : t('designer.customCanvasItem.hiddenFormulaTag') }}</span>
        </UTooltip>
      </template>
      <!-- A Popover's content: edited in its own canvas. -->
      <div
        v-if="ownSlots.length"
        data-canvas-chrome
        class="mt-1 flex flex-wrap gap-1"
      >
        <UButton
          v-for="[slot, meta] in ownSlots"
          :key="slot"
          :label="`${cat.slotLabel(field.widget ?? '', slot, meta.label)} (${ownSlotCount(slot)})`"
          icon="i-lucide-square-arrow-out-up-right"
          size="xs"
          color="neutral"
          variant="outline"
          @click="ctx.enter(field.id, 'own')"
        />
      </div>
    </template>

    <!-- Where a drop lands: a line before or after this widget. -->
    <span
      v-if="dropBefore"
      class="pointer-events-none absolute inset-y-0 -left-[7px] w-0.5 rounded bg-primary"
    />
    <span
      v-if="dropAfter"
      class="pointer-events-none absolute inset-y-0 -right-[7px] w-0.5 rounded bg-primary"
    />

    <template v-if="selected">
      <!-- The selection, drawn inside the widget's box: an outline past it is cut off by any
      scrolling container the widget fills (a Splitter's panel, a Card's Fill-height body). -->
      <span class="pointer-events-none absolute inset-0 z-[5] rounded-sm ring-2 ring-inset ring-primary" />
      <span
        class="pointer-events-none absolute z-10 rounded-sm bg-primary px-1.5 text-[11px] leading-4 text-inverted"
        :class="chromeInside ? 'top-1 left-1' : '-top-5 left-0'"
      >
        {{ definitionLabel }}{{ field.label || boundTo ? ` · ${field.label || boundTo}` : '' }}{{ resizing?.axis === 'x' ? ` · ${field.gridW}/12` : resizing?.axis === 'y' ? ` · ${t('designer.customCanvasItem.rows', { rows })}` : '' }}
      </span>
      <div
        data-canvas-chrome
        class="absolute z-10 flex gap-0.5 rounded-md bg-default shadow-sm ring ring-default"
        :class="chromeInside ? 'top-1 right-4' : '-top-6 right-0'"
      >
        <UTooltip
          v-if="hasInlineSlots && !isBlock"
          :text="t('designer.customCanvasItem.focusTooltip')"
        >
          <UButton
            icon="i-lucide-scan"
            :aria-label="t('designer.customCanvasItem.focus')"
            size="xs"
            color="neutral"
            variant="ghost"
            @click="ctx.enter(field.id, 'focus')"
          />
        </UTooltip>
        <UDropdownMenu
          :items="menuItems"
          :content="{ align: 'end' }"
        >
          <UButton
            icon="i-lucide-ellipsis-vertical"
            :aria-label="t('designer.customCanvasItem.widgetActions')"
            size="xs"
            color="neutral"
            variant="ghost"
          />
        </UDropdownMenu>
      </div>
      <template v-if="ctx.editable.value">
        <!-- Width: the right edge, snapping to columns. Inside the widget's box: one past it would widen
        an area that scrolls (a Splitter's panel) and give it a horizontal scroll bar. -->
        <span
          data-canvas-chrome
          class="absolute inset-y-0 right-0 z-10 flex w-3 cursor-ew-resize touch-none items-center justify-center"
          @pointerdown="startResize('x', $event)"
          @pointermove="onResizeMove"
          @pointerup="endResize"
          @pointercancel="endResize"
        >
          <span class="h-6 w-1 rounded-full bg-primary" />
        </span>
        <!-- Height: the bottom edge of a sizable widget (or of the Form field around one), snapping to rows. -->
        <span
          v-if="heightTarget"
          data-canvas-chrome
          class="absolute inset-x-0 bottom-0 z-10 flex h-3 cursor-ns-resize touch-none items-center justify-center"
          @pointerdown="startResize('y', $event)"
          @pointermove="onResizeMove"
          @pointerup="endResize"
          @pointercancel="endResize"
        >
          <span class="h-1 w-6 rounded-full bg-primary" />
        </span>
      </template>
    </template>
  </div>
</template>

<style scoped>
/* Hover outlines only the innermost widget under the pointer - inside its box, like the selection. */
.canvas-item-hover:hover:not(:has([data-canvas-item]:hover)) {
  outline: 1px dashed color-mix(in oklab, var(--ui-primary) 50%, transparent);
  outline-offset: -1px;
}

/* The widget is drawn, not used: its inputs and buttons don't take the pointer (a tab still does, to show its content). */
[data-canvas-widget] :deep(:is(input, textarea, select, a, button:not([role="tab"]), [contenteditable]):not([data-canvas-chrome] *)) {
  pointer-events: none;
}
</style>
