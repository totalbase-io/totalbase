<script setup lang="ts">
/**
 * The Camera widget (TCamera, DataViews.md §9.9): takes a
 * photo now, crops it, compresses it and stores it as a file - its value is
 * the file's id, so a file column (a uuid foreign key to files)
 * keeps it like UFileUpload's (WidgetFileUpload.vue: the same multipart POST
 * to /api/totalbase/table/files, under the viewer's own CREATE grant).
 *
 * A modal (fullscreen on a phone): the live camera, front or back; without
 * one (no HTTPS, no permission) the phone's own camera app through a file
 * input with `capture`. Then the crop - drag and zoom inside a frame of the
 * chosen shape - and the JPEG, scaled down to `maxSize` (utils/photo-capture.ts).
 */
import type { FileNode } from '~/types/file'
import { aspectRatio, cropGeometry, photoFileName, renderPhoto } from '~/utils/photo-capture'

const modelValue = defineModel<string | null | undefined>()
const props = withDefaults(defineProps<{
  label?: string
  facing?: 'environment' | 'user'
  aspect?: string
  maxSize?: number
  quality?: number
  /** The button's icon - unset: a camera. */
  icon?: string
  color?: 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'error' | 'neutral'
  variant?: 'solid' | 'outline' | 'soft' | 'subtle' | 'ghost' | 'link'
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  disabled?: boolean
  /** Shown, never changed: the photo only - no take, no remove. */
  readonly?: boolean
}>(), {
  label: undefined,
  facing: 'environment',
  aspect: 'original',
  maxSize: 1600,
  quality: 0.85,
  icon: undefined,
  color: undefined,
  variant: undefined,
  size: undefined,
  disabled: false,
  readonly: false
})

const { t } = useI18n()
const isCompact = useCompactUi()
const dataApi = useDataApi()
const notifyError = useErrorToast()

// --- The stored photo ----------------------------------------------------------

const preview = ref<string | null>(null)
const previewFailed = ref(false)
async function loadPreview(id: string) {
  previewFailed.value = false
  try {
    const response = await $fetch.raw(`/api/totalbase/table/files/${id}?width=320&fit=cover`, {
      baseURL: '',
      responseType: 'blob'
    })
    setPreview(URL.createObjectURL(response._data as Blob))
  } catch {
    setPreview(null)
    previewFailed.value = true
  }
}
function setPreview(url: string | null) {
  if (preview.value) URL.revokeObjectURL(preview.value)
  preview.value = url
}
watch(modelValue, (id) => {
  if (id) loadPreview(id)
  else setPreview(null)
}, { immediate: true })
onBeforeUnmount(() => setPreview(null))

// --- Taking it -----------------------------------------------------------------

const open = ref(false)
const facing = ref<'environment' | 'user'>(props.facing)
const live = ref<HTMLVideoElement | null>(null)
const cameraFailed = ref(false)
/** The photo just taken, before it's cropped. */
const taken = shallowRef<{ image: HTMLImageElement | ImageBitmap, url: string, width: number, height: number } | null>(null)

function openCamera() {
  if (props.disabled || props.readonly) return
  discardTaken()
  cameraFailed.value = false
  open.value = true
}
function close() {
  open.value = false
  live.value = null
  discardTaken()
}
function discardTaken() {
  if (taken.value) URL.revokeObjectURL(taken.value.url)
  taken.value = null
}

async function useImage(blob: Blob) {
  const bitmap = await createImageBitmap(blob)
  const url = URL.createObjectURL(blob)
  taken.value = { image: bitmap, url, width: bitmap.width, height: bitmap.height }
  zoom.value = 1
  offset.value = { x: Number.NEGATIVE_INFINITY, y: Number.NEGATIVE_INFINITY }
  nextTick(centerCrop)
}

async function capture() {
  const video = live.value
  if (!video?.videoWidth) return
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const context = canvas.getContext('2d')
  if (!context) return
  // The front camera is shown mirrored, as a mirror is; the photo is not.
  context.drawImage(video, 0, 0)
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95))
  if (blob) await useImage(blob)
}

const photoInput = useTemplateRef<HTMLInputElement>('photoInput')
async function onPhoto(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  ;(event.target as HTMLInputElement).value = ''
  if (file) await useImage(file)
}

// --- Cropping ------------------------------------------------------------------

const ratio = computed(() => aspectRatio(props.aspect))
const stage = useTemplateRef<HTMLDivElement>('stage')
const zoom = ref(1)
const offset = ref({ x: 0, y: 0 })
function frameSize() {
  const box = stage.value?.getBoundingClientRect()
  return { width: box?.width ?? 300, height: box?.height ?? 400 }
}
const geometry = computed(() => {
  if (!taken.value) return null
  // Read again whenever the zoom or the offset moves - the stage's size only changes with the modal.
  return cropGeometry(taken.value, frameSize(), zoom.value, offset.value)
})
function centerCrop() {
  if (!taken.value) return
  const frame = frameSize()
  const g = cropGeometry(taken.value, frame, zoom.value, { x: 0, y: 0 })
  offset.value = { x: (frame.width - taken.value.width * g.scale) / 2, y: (frame.height - taken.value.height * g.scale) / 2 }
}
watch(zoom, (now, before) => {
  // Zoom around the frame's center.
  if (!taken.value) return
  const frame = frameSize()
  const k = now / before
  offset.value = { x: frame.width / 2 - (frame.width / 2 - offset.value.x) * k, y: frame.height / 2 - (frame.height / 2 - offset.value.y) * k }
})
let drag: { x: number, y: number, from: { x: number, y: number } } | null = null
function onPointerDown(event: PointerEvent) {
  drag = { x: event.clientX, y: event.clientY, from: { ...(geometry.value?.offset ?? offset.value) } }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}
function onPointerMove(event: PointerEvent) {
  if (!drag) return
  offset.value = { x: drag.from.x + event.clientX - drag.x, y: drag.from.y + event.clientY - drag.y }
}
function onPointerUp() {
  drag = null
}

// --- Storing it ----------------------------------------------------------------

const uploading = ref(false)
async function usePhoto() {
  const photo = taken.value
  if (!photo) return
  uploading.value = true
  try {
    const source = ratio.value && geometry.value ? geometry.value.source : { x: 0, y: 0, width: photo.width, height: photo.height }
    const blob = await renderPhoto(photo.image, source, props.maxSize, props.quality)
    const formData = new FormData()
    formData.append('file', new File([blob], photoFileName(new Date(), t('dataviews.widgetCamera.fileStem')), { type: 'image/jpeg' }))
    const { data } = await dataApi.post<FileNode>('/totalbase/table/files', formData)
    modelValue.value = data.id
    close()
  } catch (error) {
    notifyError(error, t('dataviews.widgetCamera.uploadFailed'))
  } finally {
    uploading.value = false
  }
}

function remove() {
  modelValue.value = null
}

defineExpose({ open: openCamera, close })
</script>

<template>
  <div class="flex w-full items-center gap-3">
    <div
      v-if="modelValue"
      class="relative size-20 shrink-0 overflow-hidden rounded-lg border border-default bg-elevated"
    >
      <img
        v-if="preview"
        :src="preview"
        class="size-full object-cover"
        alt=""
      >
      <UIcon
        v-else
        :name="previewFailed ? 'i-lucide-image-off' : 'i-lucide-loader-circle'"
        :class="['absolute inset-0 m-auto size-6 text-muted', !previewFailed && 'animate-spin']"
      />
    </div>
    <div
      v-if="!readonly"
      class="flex flex-wrap items-center gap-2"
    >
      <UButton
        :icon="icon || 'i-lucide-camera'"
        :label="label || (modelValue ? t('dataviews.widgetCamera.retake') : t('dataviews.widgetCamera.takePhoto'))"
        :color="color"
        :variant="variant"
        :size="size"
        :disabled="disabled"
        @click="openCamera"
      />
      <UButton
        v-if="modelValue"
        icon="i-lucide-x"
        :aria-label="t('dataviews.widgetCamera.remove')"
        color="neutral"
        variant="ghost"
        :size="size"
        :disabled="disabled"
        @click="remove"
      />
    </div>

    <UModal
      v-model:open="open"
      :title="taken ? t('dataviews.widgetCamera.cropTitle') : t('dataviews.widgetCamera.title')"
      :fullscreen="isCompact"
      @after:leave="close"
    >
      <template #body>
        <div class="flex flex-col items-center gap-3">
          <!-- Taking it: the live camera, or the phone's camera app. -->
          <div
            v-if="!taken"
            class="relative aspect-[3/4] w-full overflow-hidden rounded-lg md:aspect-video"
          >
            <CameraFeed
              v-if="open"
              :facing="facing"
              :ideal="{ width: 2560, height: 1440 }"
              @ready="video => { live = video; cameraFailed = false }"
              @problem="() => { cameraFailed = true }"
            />
          </div>

          <!-- Cropping it: drag and zoom inside the frame. -->
          <template v-else>
            <div
              v-if="ratio"
              ref="stage"
              class="relative w-full max-w-sm touch-none overflow-hidden rounded-lg bg-black select-none"
              :style="{ aspectRatio: String(ratio) }"
              @pointerdown="onPointerDown"
              @pointermove="onPointerMove"
              @pointerup="onPointerUp"
              @pointercancel="onPointerUp"
            >
              <img
                :src="taken.url"
                class="pointer-events-none absolute top-0 left-0 max-w-none origin-top-left"
                :style="geometry ? { width: `${taken.width * geometry.scale}px`, height: `${taken.height * geometry.scale}px`, transform: `translate(${geometry.offset.x}px, ${geometry.offset.y}px)` } : {}"
                alt=""
              >
            </div>
            <img
              v-else
              :src="taken.url"
              class="max-h-[60vh] w-full rounded-lg object-contain"
              alt=""
            >
            <UFormField
              v-if="ratio"
              :label="t('dataviews.widgetCamera.zoom')"
              class="w-full max-w-sm"
            >
              <USlider
                v-model="zoom"
                :min="1"
                :max="4"
                :step="0.05"
              />
            </UFormField>
          </template>

          <input
            ref="photoInput"
            type="file"
            accept="image/*"
            :capture="facing"
            class="hidden"
            @change="onPhoto"
          >
        </div>
      </template>
      <template #footer>
        <div class="flex w-full flex-wrap items-center justify-between gap-2">
          <div class="flex gap-2">
            <UButton
              v-if="!taken && !cameraFailed"
              icon="i-lucide-switch-camera"
              :aria-label="t('dataviews.widgetCamera.switchCamera')"
              color="neutral"
              variant="outline"
              @click="facing = facing === 'user' ? 'environment' : 'user'"
            />
            <UButton
              v-if="taken"
              icon="i-lucide-rotate-ccw"
              :label="t('dataviews.widgetCamera.again')"
              color="neutral"
              variant="outline"
              :disabled="uploading"
              @click="discardTaken"
            />
          </div>
          <div class="flex gap-2">
            <UButton
              :label="t('common.cancel')"
              color="neutral"
              variant="outline"
              @click="close"
            />
            <UButton
              v-if="taken"
              icon="i-lucide-check"
              :label="t('dataviews.widgetCamera.use')"
              :loading="uploading"
              @click="usePhoto"
            />
            <UButton
              v-else-if="cameraFailed"
              icon="i-lucide-image-plus"
              :label="t('dataviews.widgetCamera.useCameraApp')"
              @click="photoInput?.click()"
            />
            <UButton
              v-else
              icon="i-lucide-aperture"
              :label="t('dataviews.widgetCamera.capture')"
              :disabled="!live"
              @click="capture"
            />
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
