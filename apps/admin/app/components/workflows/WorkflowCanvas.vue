<script setup lang="ts">
/**
 * The workflow editor's canvas: a dotted, scrollable area the tree (the
 * default slot) sits in, with its zoom.
 *
 * Zoom via CSS `zoom` (not `transform: scale`) so the scrollable area's
 * bounds actually grow/shrink with it - a transform-scaled box keeps its
 * original layout size, which would clip a zoomed-in tree instead of
 * letting the container scroll to it. Ctrl/Cmd+wheel over the canvas zooms
 * like every other canvas-ish editor; a plain wheel still scrolls normally.
 *
 * The canvas can't just `justify-center` the tree: once the tree is wider
 * than its own container, the container shrinks-to-fit its content (same
 * "flex box defaults to block sizing" gotcha WorkflowTree.vue's own doc
 * comment hit), so there's no extra space for `justify-center` to
 * distribute - the tree just renders flush against the container's edge,
 * with nothing to scroll to on the other side. `gutterPx` below gives a
 * gutter on both sides so there's room to scroll into - sized to the
 * tree's *actual* overflow past the viewport (measured, not a fixed guess)
 * so a small tree that already fits shows no horizontal scrollbar at all.
 * It only ever grows (never shrinks back down) so adding a step that
 * widens the tree doesn't visually shift everything already on screen.
 * The row itself centers with `justify-center-safe`, so even when the
 * gutter measured short (it did on a phone) a tree wider than the canvas
 * starts at the left edge instead of overflowing it, out of scroll reach.
 */
const { t } = useI18n()
const ZOOM_MIN = 0.5
const ZOOM_MAX = 1.5
const ZOOM_STEP = 0.1
const zoom = ref(1)
function zoomBy(delta: number) {
  zoom.value = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((zoom.value + delta) * 100) / 100))
}
function onCanvasWheel(event: WheelEvent) {
  if (!event.ctrlKey && !event.metaKey) return
  event.preventDefault()
  zoomBy(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)
}

const canvasEl = ref<HTMLElement | null>(null)
const treeWrapperEl = ref<HTMLElement | null>(null)
const gutterPx = ref(0)
function growGutterToFit() {
  const canvas = canvasEl.value
  const tree = treeWrapperEl.value
  if (!canvas || !tree) return
  const overflow = tree.getBoundingClientRect().width - canvas.clientWidth
  if (overflow > 0) gutterPx.value = Math.max(gutterPx.value, Math.ceil(overflow / 2) + 64)
}
let resizeObserver: ResizeObserver | undefined
// The page's top-level `await useAsyncData` means the tree is already
// resolved by the time this component mounts - `onMounted` (not a `watch`,
// immediate or otherwise) is what's guaranteed to run after the refs below
// are actually attached to real DOM elements from that first render.
// A phone or tablet opens a tree wider than the canvas zoomed out to fit it
// (down to ZOOM_MIN) - the whole flow first, + to look closer. Desktop keeps 100%.
const isCompact = useCompactUi()
function fitZoomToCanvas() {
  const canvas = canvasEl.value
  const tree = treeWrapperEl.value
  if (!canvas || !tree) return
  const available = canvas.clientWidth - 32
  const width = tree.getBoundingClientRect().width
  if (width <= available) return
  zoom.value = Math.max(ZOOM_MIN, Math.floor((available / width) * 10) / 10)
}
onMounted(async () => {
  if (isCompact.value) {
    fitZoomToCanvas()
    await nextTick()
  }
  growGutterToFit()
  await nextTick() // let any new gutter padding actually land in the DOM before measuring against it
  const canvas = canvasEl.value
  const tree = treeWrapperEl.value
  if (canvas && tree) {
    // Measures the tree's *actual* rendered bounding box (not a guessed
    // midpoint - a false-branch-heavy tree isn't symmetric around its own
    // center) to scroll it into view once on first load, the same "fit
    // view on init" moment Vue Flow's own `fit-view-on-init` used to own -
    // not on every later resize, or adding a step somewhere off-screen
    // would keep yanking the user's own scroll position back to center.
    const canvasRect = canvas.getBoundingClientRect()
    const treeRect = tree.getBoundingClientRect()
    canvas.scrollLeft += (treeRect.left + treeRect.width / 2) - (canvasRect.left + canvasRect.width / 2)
  }
  if (tree) {
    resizeObserver = new ResizeObserver(() => growGutterToFit())
    resizeObserver.observe(tree)
  }
})
onBeforeUnmount(() => resizeObserver?.disconnect())
</script>

<template>
  <div class="relative min-h-[620px] flex-1 overflow-hidden rounded-lg border border-default">
    <div
      ref="canvasEl"
      class="h-full overflow-auto bg-default py-8"
      style="background-image: radial-gradient(var(--ui-border) 1px, transparent 1px); background-size: 18px 18px;"
      @wheel="onCanvasWheel"
    >
      <div
        class="flex justify-center-safe"
        :style="{ paddingLeft: `${gutterPx}px`, paddingRight: `${gutterPx}px` }"
      >
        <div
          ref="treeWrapperEl"
          :style="{ zoom }"
        >
          <slot />
        </div>
      </div>
    </div>

    <div class="absolute bottom-3 right-3 flex flex-col overflow-hidden rounded-lg border border-default bg-elevated shadow-sm">
      <UButton
        icon="i-lucide-plus"
        :aria-label="t('workflows.editor.zoomIn')"
        color="neutral"
        variant="ghost"
        square
        :disabled="zoom >= ZOOM_MAX"
        @click="zoomBy(ZOOM_STEP)"
      />
      <UButton
        icon="i-lucide-rotate-ccw"
        :aria-label="t('workflows.editor.resetZoom')"
        color="neutral"
        variant="ghost"
        square
        :disabled="zoom === 1"
        @click="zoom = 1"
      />
      <UButton
        icon="i-lucide-minus"
        :aria-label="t('workflows.editor.zoomOut')"
        color="neutral"
        variant="ghost"
        square
        :disabled="zoom <= ZOOM_MIN"
        @click="zoomBy(-ZOOM_STEP)"
      />
    </div>
  </div>
</template>
