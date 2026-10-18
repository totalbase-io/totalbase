<script setup lang="ts">
/**
 * The Scanner widget (TScanner, Specification_DataViews.md §9.9): reads a
 * QR code, a PDF417 (the Argentine DNI) or a barcode and emits `scan`
 * `{ value, format, source }`, keeping the code in its Value.
 *
 * - **USB reader in keyboard mode**: it types the code and Enter. In `field`
 *   mode the text field takes it (a person may type too - Enter reads);
 *   in `page` mode a fast burst of keys anywhere on the page is read while
 *   nothing editable has the focus - a kiosk with no field to click.
 * - **Camera**: a modal (fullscreen on a phone) reading frames with the
 *   browser's detector or zxing-wasm (utils/code-scanner.ts). Without a
 *   live camera (no HTTPS, no permission) it offers taking a photo of the
 *   code instead - the phone's own camera app, read as a still image.
 */
import { parseScannerFormats, createFrameReader, createKeyburstReader, scanFeedback, type FrameReader, type ScanResult } from '~/utils/code-scanner'

const modelValue = defineModel<string | null | undefined>()
const props = withDefaults(defineProps<{
  input?: boolean
  camera?: boolean
  listen?: 'field' | 'page'
  formats?: string
  continuous?: boolean
  beep?: boolean
  vibrate?: boolean
  label?: string
  /** The camera button's icon - unset: a barcode. */
  icon?: string
  color?: 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'error' | 'neutral'
  variant?: 'solid' | 'outline' | 'soft' | 'subtle' | 'ghost' | 'link'
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  disabled?: boolean
}>(), {
  input: true,
  camera: true,
  listen: 'field',
  formats: '',
  continuous: false,
  beep: true,
  vibrate: true,
  label: undefined,
  icon: undefined,
  color: undefined,
  variant: undefined,
  size: undefined,
  disabled: false
})
const emit = defineEmits<{
  scan: [result: ScanResult]
  error: [error: { message: string }]
}>()

const { t } = useI18n()
const isCompact = useCompactUi()
const text = ref(modelValue.value ?? '')
watch(modelValue, (value) => {
  text.value = value ?? ''
})
const field = useTemplateRef<{ inputRef?: HTMLInputElement }>('field')

/** A code read, from anywhere: kept, announced, and the field ready for the next one. */
function read(result: ScanResult) {
  const value = result.value.trim()
  if (!value || props.disabled) return
  scanFeedback({ beep: props.beep, vibrate: props.vibrate })
  modelValue.value = value
  text.value = value
  emit('scan', { ...result, value })
  // The next burst replaces it instead of being appended to it.
  nextTick(() => field.value?.inputRef?.select())
}

function onEnter() {
  read({ value: text.value, format: null, source: 'keyboard' })
}

// --- A USB reader typing anywhere on the page (listen: page) ----------------

const burst = createKeyburstReader()
function isEditable(element: Element | null): boolean {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || (element instanceof HTMLElement && element.isContentEditable)
}
function onPageKey(event: KeyboardEvent) {
  if (props.disabled || open.value || isEditable(document.activeElement)) return
  const code = burst.feed(event)
  if (code) {
    event.preventDefault()
    read({ value: code, format: null, source: 'keyboard' })
  }
}
watch(() => props.listen, (listen) => {
  window.removeEventListener('keydown', onPageKey)
  if (listen === 'page') window.addEventListener('keydown', onPageKey)
}, { immediate: true })
onBeforeUnmount(() => window.removeEventListener('keydown', onPageKey))

// --- The camera ---------------------------------------------------------------

const open = ref(false)
const status = ref('')
/** The live camera failed - the photo of the code is what's left. */
const cameraFailed = ref(false)
let reader: FrameReader | null = null
let scanning = false
let lastValue = ''
let lastAt = 0

async function frameReader() {
  reader ??= await createFrameReader(parseScannerFormats(props.formats))
  return reader
}

async function onReady(video: HTMLVideoElement) {
  cameraFailed.value = false
  status.value = t('dataviews.widgetScanner.pointAtCode')
  const frames = await frameReader()
  scanning = true
  while (scanning && open.value) {
    try {
      const found = await frames.read(video)
      // Keep reading: the same code again only after a pause, so it isn't read twice in a row.
      if (found && !(found.value === lastValue && Date.now() - lastAt < 2500)) {
        lastValue = found.value
        lastAt = Date.now()
        read({ ...found, source: 'camera' })
        status.value = t('dataviews.widgetScanner.read', { value: found.value.length > 40 ? `${found.value.slice(0, 40)}…` : found.value })
        if (!props.continuous) {
          close()
          break
        }
      }
    } catch (error) {
      status.value = error instanceof Error ? error.message : String(error)
    }
    await new Promise(resolve => setTimeout(resolve, frames.native ? 120 : 250))
  }
}

function onProblem(_problem: string, message: string) {
  cameraFailed.value = true
  emit('error', { message })
}

function openCamera() {
  if (props.disabled) return
  lastValue = ''
  open.value = true
}
function close() {
  scanning = false
  open.value = false
}
watch(open, (isOpen) => {
  if (!isOpen) scanning = false
})

// A photo of the code - the phone's camera app, over plain HTTP too.
const photoInput = useTemplateRef<HTMLInputElement>('photoInput')
const readingPhoto = ref(false)
async function onPhoto(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  ;(event.target as HTMLInputElement).value = ''
  if (!file) return
  readingPhoto.value = true
  try {
    const found = await (await frameReader()).read(file)
    if (found) {
      read({ ...found, source: 'camera' })
      close()
    } else status.value = t('dataviews.widgetScanner.photoNoCode')
  } catch (error) {
    status.value = error instanceof Error ? error.message : String(error)
  } finally {
    readingPhoto.value = false
  }
}

defineExpose({
  open: openCamera,
  close,
  focus: () => field.value?.inputRef?.focus()
})
</script>

<template>
  <!-- A button alone is inline: the Style tab's alignment places it (left, center, right). -->
  <div :class="input ? 'flex w-full items-center gap-2' : 'inline-flex items-center gap-2'">
    <UInput
      v-if="input"
      ref="field"
      v-model="text"
      class="min-w-0 flex-1"
      icon="i-lucide-scan-line"
      :color="color"
      :size="size"
      :disabled="disabled"
      :aria-label="t('dataviews.widgetScanner.fieldLabel')"
      autocomplete="off"
      @keydown.enter.prevent="onEnter"
    >
      <template
        v-if="camera"
        #trailing
      >
        <UButton
          icon="i-lucide-camera"
          :aria-label="t('dataviews.widgetScanner.openCamera')"
          color="neutral"
          variant="link"
          size="xs"
          :disabled="disabled"
          @click="openCamera"
        />
      </template>
    </UInput>
    <UButton
      v-else-if="camera"
      :icon="icon || 'i-lucide-scan-barcode'"
      :label="label || undefined"
      :aria-label="t('dataviews.widgetScanner.openCamera')"
      :color="color"
      :variant="variant"
      :size="size"
      :disabled="disabled"
      @click="openCamera"
    />

    <UModal
      v-model:open="open"
      :title="t('dataviews.widgetScanner.title')"
      :fullscreen="isCompact"
    >
      <template #body>
        <div class="flex flex-col gap-3">
          <div class="relative aspect-[3/4] w-full overflow-hidden rounded-lg md:aspect-video">
            <CameraFeed
              v-if="open"
              facing="environment"
              @ready="onReady"
              @problem="onProblem"
            >
              <!-- The frame to aim with - wide, as a PDF417 is. -->
              <div class="pointer-events-none absolute inset-x-[8%] top-1/2 h-1/3 -translate-y-1/2 rounded-lg border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
            </CameraFeed>
          </div>
          <p
            v-if="status"
            class="text-center text-sm text-muted"
          >
            {{ status }}
          </p>
          <div
            v-if="cameraFailed"
            class="flex justify-center"
          >
            <UButton
              icon="i-lucide-image-plus"
              :label="t('dataviews.widgetScanner.photoFallback')"
              :loading="readingPhoto"
              @click="photoInput?.click()"
            />
          </div>
          <input
            ref="photoInput"
            type="file"
            accept="image/*"
            capture="environment"
            class="hidden"
            @change="onPhoto"
          >
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end">
          <UButton
            :label="t('dataviews.widgetScanner.close')"
            color="neutral"
            variant="outline"
            @click="close"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
