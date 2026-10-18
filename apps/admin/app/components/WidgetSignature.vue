<script setup lang="ts">
import { photoFileName } from '~/utils/photo-capture'
/**
 * The Signature widget (TSignature, Specification_DataViews.md §9.9): a pad to sign on with a finger, a pen or
 * the mouse - stored as a PNG file, its value the file's id, so a file column (a uuid foreign key to
 * files) keeps it like the Camera's and UFileUpload's (the same multipart POST to
 * /api/totalbase/table/files, under the viewer's own CREATE grant).
 *
 * In line, no modal of its own: a page that wants "a card with the signature and a Sign button" puts this in
 * a UModal behind the button, and shows the signature with a read-only Signature (or Camera) on the same
 * column. Clear starts over; a few ink colors (`colors`). A signature is stored once it's done - when the
 * pointer leaves the pad, after a short pause, or when the page asks (`submit()`, before closing its modal).
 * Like UFileUpload, a signature replaced leaves its old file behind (Files can clean it up).
 */
import type { FileNode } from '~/types/file'

const modelValue = defineModel<string | null | undefined>()
const props = withDefaults(defineProps<{
  /** The pad's height in pixels - it takes the field's width. */
  height?: number
  /** A few ink colors to pick from - off: black only. */
  colors?: boolean
  /** The signature shown, never changed. */
  readonly?: boolean
  disabled?: boolean
}>(), {
  height: 180,
  colors: true,
  readonly: false,
  disabled: false
})

const { t } = useI18n()
const dataApi = useDataApi()
const session = useSession()
const notifyError = useErrorToast()
const showOnly = computed(() => props.readonly || props.disabled)

// --- The stored signature ------------------------------------------------------

const stored = ref<string | null>(null)
const storedFailed = ref(false)
async function loadStored(id: string) {
  storedFailed.value = false
  try {
    const response = await $fetch.raw(`/api/totalbase/table/files/${id}`, {
      baseURL: '',
      responseType: 'blob',
      headers: session.token.value ? { Authorization: `Bearer ${session.token.value}` } : undefined
    })
    setStored(URL.createObjectURL(response._data as Blob))
  } catch {
    setStored(null)
    storedFailed.value = true
  }
}
function setStored(url: string | null) {
  if (stored.value) URL.revokeObjectURL(stored.value)
  stored.value = url
}
/** The id this pad just stored - its own value coming back needs no reload. */
let ownId: string | null = null
watch(modelValue, (id) => {
  if (id && id === ownId) return
  if (id) loadStored(id)
  else setStored(null)
}, { immediate: true })
onBeforeUnmount(() => setStored(null))

// --- Drawing -------------------------------------------------------------------

/** Ink: black, blue, red - what a pen signs with. */
const INKS = ['#111827', '#1d4ed8', '#b91c1c'] as const
const ink = ref<string>(INKS[0])
const canvas = useTemplateRef<HTMLCanvasElement>('canvas')
/** Drawn since it was last stored. */
const dirty = ref(false)
/** Anything drawn on the pad at all. */
const drawn = ref(false)
let last: { x: number, y: number } | null = null
let mid: { x: number, y: number } | null = null

/** The pad's pixels follow its size on screen and the screen's density - sharp on a phone. */
function fitCanvas() {
  const element = canvas.value
  if (!element) return
  const ratio = window.devicePixelRatio || 1
  const width = Math.round(element.clientWidth * ratio)
  const height = Math.round(props.height * ratio)
  if (element.width === width && element.height === height) return
  // Resizing a canvas wipes it: only while nothing is drawn.
  if (drawn.value) return
  element.width = width
  element.height = height
}
let resizeObserver: ResizeObserver | null = null
watch(canvas, (element) => {
  resizeObserver?.disconnect()
  if (!element) return
  fitCanvas()
  resizeObserver = new ResizeObserver(fitCanvas)
  resizeObserver.observe(element)
})
onBeforeUnmount(() => resizeObserver?.disconnect())

function point(event: PointerEvent) {
  const element = canvas.value!
  const box = element.getBoundingClientRect()
  return { x: (event.clientX - box.left) * (element.width / box.width), y: (event.clientY - box.top) * (element.height / box.height) }
}
function context() {
  const ctx = canvas.value?.getContext('2d')
  if (!ctx) return null
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = ink.value
  ctx.fillStyle = ink.value
  ctx.lineWidth = 2.2 * (window.devicePixelRatio || 1)
  return ctx
}
function onDown(event: PointerEvent) {
  if (showOnly.value || event.button > 0) return
  canvas.value?.setPointerCapture(event.pointerId)
  clearTimeout(idleTimer)
  last = point(event)
  mid = last
  const ctx = context()
  // A dot, for a tap.
  ctx?.beginPath()
  ctx?.arc(last.x, last.y, ctx.lineWidth / 2, 0, Math.PI * 2)
  ctx?.fill()
  drawn.value = true
  dirty.value = true
}
function onMove(event: PointerEvent) {
  if (!last || !mid) return
  const ctx = context()
  if (!ctx) return
  const next = point(event)
  // A smooth line: a curve through the midpoints, each sample its control point.
  const nextMid = { x: (last.x + next.x) / 2, y: (last.y + next.y) / 2 }
  ctx.beginPath()
  ctx.moveTo(mid.x, mid.y)
  ctx.quadraticCurveTo(last.x, last.y, nextMid.x, nextMid.y)
  ctx.stroke()
  last = next
  mid = nextMid
}
let idleTimer: ReturnType<typeof setTimeout> | undefined
function onUp(event: PointerEvent) {
  if (!last) return
  canvas.value?.releasePointerCapture(event.pointerId)
  last = null
  mid = null
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => void submit(), 1500)
}
onBeforeUnmount(() => clearTimeout(idleTimer))

// --- Storing -------------------------------------------------------------------

const uploading = ref(false)
let pending: Promise<void> | null = null
/** Stores what's drawn, once - the page's Accept may await it (`dataview.controls.<name>.submit()`). */
async function submit(): Promise<void> {
  clearTimeout(idleTimer)
  if (pending) return pending
  if (!dirty.value || !canvas.value) return
  pending = (async () => {
    uploading.value = true
    try {
      dirty.value = false
      const blob = await new Promise<Blob | null>(resolve => canvas.value!.toBlob(resolve, 'image/png'))
      if (!blob) return
      const formData = new FormData()
      formData.append('file', new File([blob], photoFileName(new Date(), t('dataviews.widgetSignature.fileStem'), 'png'), { type: 'image/png' }))
      const { data } = await dataApi.post<FileNode>('/totalbase/table/files', formData)
      ownId = data.id
      modelValue.value = data.id
    } catch (error) {
      dirty.value = true
      notifyError(error, t('dataviews.widgetSignature.uploadFailed'))
    } finally {
      uploading.value = false
      pending = null
    }
  })()
  return pending
}

/** Starts over: an empty pad, and no value. */
function clear() {
  clearTimeout(idleTimer)
  const element = canvas.value
  element?.getContext('2d')?.clearRect(0, 0, element.width, element.height)
  drawn.value = false
  dirty.value = false
  ownId = null
  setStored(null)
  modelValue.value = null
  nextTick(fitCanvas)
}

defineExpose({ clear, submit })
</script>

<template>
  <div class="flex w-full flex-col gap-2">
    <!-- Stored and not being redrawn: the signature itself. -->
    <div
      v-if="modelValue && !drawn"
      class="flex w-full items-center justify-center overflow-hidden rounded-md border border-default bg-default"
      :style="{ height: `${height}px` }"
    >
      <img
        v-if="stored"
        :src="stored"
        :alt="t('dataviews.widgetSignature.alt')"
        class="max-h-full max-w-full object-contain"
      >
      <span
        v-else-if="storedFailed"
        class="text-xs text-muted"
      >{{ t('dataviews.widgetSignature.unavailable') }}</span>
    </div>
    <div
      v-else-if="showOnly"
      class="flex w-full items-center justify-center rounded-md border border-dashed border-default text-xs text-muted"
      :style="{ height: `${height}px` }"
    >
      {{ t('dataviews.widgetSignature.none') }}
    </div>
    <canvas
      v-else
      ref="canvas"
      class="w-full touch-none rounded-md border border-default bg-default"
      :style="{ height: `${height}px` }"
      :aria-label="t('dataviews.widgetSignature.pad')"
      role="img"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
      @pointerleave="submit"
    />

    <div
      v-if="!showOnly"
      class="flex items-center justify-between gap-2"
    >
      <div
        v-if="colors && !(modelValue && !drawn)"
        class="flex items-center gap-1.5"
        role="radiogroup"
        :aria-label="t('dataviews.widgetSignature.ink')"
      >
        <button
          v-for="color in INKS"
          :key="color"
          type="button"
          role="radio"
          :aria-checked="ink === color"
          :aria-label="t('dataviews.widgetSignature.inkColor', { color })"
          class="size-5 rounded-full ring-offset-2 ring-offset-(--ui-bg)"
          :class="ink === color ? 'ring-2 ring-(--ui-border-inverted)' : undefined"
          :style="{ backgroundColor: color }"
          @click="ink = color"
        />
      </div>
      <span v-else />
      <div class="flex items-center gap-2">
        <UIcon
          v-if="uploading"
          name="i-lucide-loader-circle"
          class="size-4 animate-spin text-muted"
        />
        <UButton
          icon="i-lucide-eraser"
          :label="t('dataviews.widgetSignature.clear')"
          color="neutral"
          variant="ghost"
          size="xs"
          :disabled="!drawn && !modelValue"
          @click="clear"
        />
      </div>
    </div>
  </div>
</template>
