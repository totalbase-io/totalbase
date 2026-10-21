<script setup lang="ts">
/**
 * A TREE DataView's org chart (DataViews.md §5.14): boxes under their parent on a canvas that
 * scrolls both ways and pans by dragging its background, with − / + / Fit to width. It opens whole when it fits,
 * else fitted to the width (never below MIN_ZOOM - past that, it scrolls).
 */
import type { TreeNode } from './TreeView.vue'
import type { TreeItem } from './DataViewTreeView.vue'

defineProps<{
  nodes: TreeNode<TreeItem>[]
  canCreate: boolean
  swatch: (color: string | null) => string | undefined
}>()
const emit = defineEmits<{
  'edit': [row: Record<string, unknown>]
  'add-child': [node: TreeNode<TreeItem>]
}>()
const collapsed = defineModel<string[]>('collapsed', { required: true })

const { t } = useI18n()
const MIN_ZOOM = 0.4
const MAX_ZOOM = 1.5
const STEP = 0.1

const viewport = ref<HTMLElement | null>(null)
const content = ref<HTMLElement | null>(null)
/** The chart's own size, unscaled - a transform doesn't change it. */
const natural = ref({ width: 0, height: 0 })
const zoom = ref(1)
const clamp = (value: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100))
const fitZoom = () => (viewport.value && natural.value.width ? Math.min(1, (viewport.value.clientWidth - 16) / natural.value.width) : 1)

function setZoom(value: number) {
  const el = viewport.value
  const next = clamp(value)
  if (!el || next === zoom.value) return
  // Keep the middle of what's in sight where it is.
  const ratio = next / zoom.value
  const centerX = el.scrollLeft + el.clientWidth / 2
  const centerY = el.scrollTop + el.clientHeight / 2
  zoom.value = next
  nextTick(() => {
    el.scrollLeft = centerX * ratio - el.clientWidth / 2
    el.scrollTop = centerY * ratio - el.clientHeight / 2
  })
}
const fit = () => setZoom(fitZoom())

let observer: ResizeObserver | undefined
let framed = false
onMounted(() => {
  observer = new ResizeObserver(() => {
    if (!content.value) return
    natural.value = { width: content.value.offsetWidth, height: content.value.offsetHeight }
    // Framed once, when it first has a size: whole if it fits, else to the width.
    if (!framed && natural.value.width > 0) {
      framed = true
      zoom.value = clamp(fitZoom())
      nextTick(() => {
        if (viewport.value) viewport.value.scrollLeft = (viewport.value.scrollWidth - viewport.value.clientWidth) / 2
      })
    }
  })
  if (content.value) observer.observe(content.value)
})
onBeforeUnmount(() => observer?.disconnect())

// --- Panning: a drag on the background (never on a box's own buttons) scrolls the canvas -------------------------

let pan: { x: number, y: number, left: number, top: number, id: number } | null = null
const panning = ref(false)
function onPointerDown(event: PointerEvent) {
  const el = viewport.value
  if (!el || event.button !== 0 || (event.target as HTMLElement).closest('button, a, input')) return
  pan = { x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop, id: event.pointerId }
  el.setPointerCapture(event.pointerId)
  panning.value = true
}
function onPointerMove(event: PointerEvent) {
  const el = viewport.value
  if (!el || !pan || event.pointerId !== pan.id) return
  el.scrollLeft = pan.left - (event.clientX - pan.x)
  el.scrollTop = pan.top - (event.clientY - pan.y)
}
function onPointerUp(event: PointerEvent) {
  if (!pan || event.pointerId !== pan.id) return
  viewport.value?.releasePointerCapture(event.pointerId)
  pan = null
  panning.value = false
}
/** Ctrl + wheel zooms, as a map does; the wheel alone scrolls. */
function onWheel(event: WheelEvent) {
  if (!event.ctrlKey && !event.metaKey) return
  event.preventDefault()
  setZoom(zoom.value + (event.deltaY < 0 ? STEP : -STEP))
}
</script>

<template>
  <div class="relative flex min-h-0 min-w-0 flex-1 flex-col">
    <div
      ref="viewport"
      class="min-h-0 min-w-0 flex-1 overflow-auto rounded-md border border-default bg-elevated/40 p-2"
      :class="panning ? 'cursor-grabbing select-none' : 'cursor-grab'"
      role="tree"
      :aria-label="t('dataviews.treeView.label')"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @wheel="onWheel"
    >
      <!-- The sizer takes the scaled size, so the scrollbars follow the zoom; centered while narrower. -->
      <div
        class="mx-auto"
        :style="{ width: `${natural.width * zoom}px`, height: `${natural.height * zoom}px` }"
      >
        <div
          ref="content"
          class="w-max origin-top-left"
          :style="{ transform: `scale(${zoom})` }"
        >
          <ul class="org-chart">
            <DataViewTreeOrgNode
              v-for="node in nodes"
              :key="node.id"
              v-model:collapsed="collapsed"
              :node="node"
              :can-create="canCreate"
              :swatch="swatch"
              @edit="emit('edit', $event)"
              @add-child="emit('add-child', $event)"
            />
          </ul>
        </div>
      </div>
    </div>
    <UFieldGroup class="absolute end-3 bottom-3 shadow-sm">
      <UButton
        icon="i-lucide-minus"
        color="neutral"
        variant="outline"
        size="sm"
        :aria-label="t('dataviews.treeView.zoomOut')"
        :disabled="zoom <= MIN_ZOOM"
        @click="setZoom(zoom - STEP)"
      />
      <UButton
        :label="`${Math.round(zoom * 100)}%`"
        color="neutral"
        variant="outline"
        size="sm"
        class="w-14 justify-center tabular-nums"
        :aria-label="t('dataviews.treeView.zoomReset')"
        @click="setZoom(1)"
      />
      <UButton
        icon="i-lucide-plus"
        color="neutral"
        variant="outline"
        size="sm"
        :aria-label="t('dataviews.treeView.zoomIn')"
        :disabled="zoom >= MAX_ZOOM"
        @click="setZoom(zoom + STEP)"
      />
      <UTooltip :text="t('dataviews.treeView.fitWidth')">
        <UButton
          icon="i-lucide-move-horizontal"
          color="neutral"
          variant="outline"
          size="sm"
          :aria-label="t('dataviews.treeView.fitWidth')"
          @click="fit"
        />
      </UTooltip>
    </UFieldGroup>
  </div>
</template>

<style scoped>
/* The connectors: each level centered under its parent, lines drawn by the list items' edges. */
.org-chart, .org-chart :deep(ul) {
  display: flex;
  justify-content: center;
  padding-top: 1.25rem;
  position: relative;
}
.org-chart {
  padding-top: 0;
}
.org-chart :deep(li) {
  list-style: none;
  position: relative;
  padding: 1.25rem 0.5rem 0;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.org-chart > :deep(li) {
  padding-top: 0;
}
.org-chart :deep(li)::before, .org-chart :deep(li)::after {
  content: '';
  position: absolute;
  top: 0;
  right: 50%;
  width: 50%;
  height: 1.25rem;
  border-top: 1px solid var(--ui-border-accented);
}
.org-chart :deep(li)::after {
  right: auto;
  left: 50%;
  border-left: 1px solid var(--ui-border-accented);
}
.org-chart :deep(li:only-child)::before, .org-chart :deep(li:only-child)::after, .org-chart > :deep(li)::before, .org-chart > :deep(li)::after {
  display: none;
}
/* An only child hangs straight from its parent's line. */
.org-chart :deep(ul > li:only-child) {
  padding-top: 0;
}
.org-chart :deep(li:first-child)::before, .org-chart :deep(li:last-child)::after {
  border: 0;
}
.org-chart :deep(li:last-child)::before {
  border-right: 1px solid var(--ui-border-accented);
}
.org-chart :deep(ul)::before {
  content: '';
  position: absolute;
  top: 0;
  left: 50%;
  height: 1.25rem;
  border-left: 1px solid var(--ui-border-accented);
}
</style>
