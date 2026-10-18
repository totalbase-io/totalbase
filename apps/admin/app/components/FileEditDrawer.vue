<script setup lang="ts">
import type Cropper from 'cropperjs'
import type { FileNode } from '~/types/file'

const props = defineProps<{
  file: FileNode | null
}>()

const emit = defineEmits<{
  /** "Save and replace" succeeded - parent should refresh its copy of this file. */
  replaced: [file: FileNode]
  /** "Save as" succeeded - parent should refresh its file list. */
  created: [file: FileNode]
}>()

const open = defineModel<boolean>('open', { required: true })

const filesApi = useFilesApi()
const toast = useToast()
const session = useSession()
const { t } = useI18n()
const notifyError = useErrorToast()

const FORMAT_OPTIONS = computed(() => [
  { label: t('content.files.editImage.keepOriginal'), value: 'original' as const },
  { label: 'JPEG', value: 'jpeg' as const },
  { label: 'PNG', value: 'png' as const },
  { label: 'WebP', value: 'webp' as const },
  { label: 'AVIF', value: 'avif' as const }
])
const FIT_OPTIONS = computed(() => [
  { label: t('content.files.editImage.fitCover'), value: 'cover' as const },
  { label: t('content.files.editImage.fitContain'), value: 'contain' as const },
  { label: t('content.files.editImage.fitInside'), value: 'inside' as const }
])

// --- Edit params (mirrors packages/files/src/transform-params.ts) ---
const width = ref<number | null>(null)
const height = ref<number | null>(null)
const fit = ref<'cover' | 'contain' | 'inside'>('cover')
const format = ref<'original' | 'jpeg' | 'png' | 'webp' | 'avif'>('original')
const quality = ref<number | null>(null)
const rotateDeg = ref(0)
const flip = ref<'horizontal' | 'vertical' | null>(null)
const grayscale = ref(false)
const blur = ref<number | null>(null)
const sharpen = ref(false)
const crop = ref<{ left: number, top: number, width: number, height: number } | null>(null)

function resetParams() {
  width.value = null
  height.value = null
  fit.value = 'cover'
  format.value = 'original'
  quality.value = null
  rotateDeg.value = 0
  flip.value = null
  grayscale.value = false
  blur.value = null
  sharpen.value = false
  crop.value = null
}

function authHeaders() {
  return session.token.value ? { Authorization: `Bearer ${session.token.value}` } : undefined
}

function buildQuery(): Record<string, string> {
  const q: Record<string, string> = {}
  if (width.value) q.width = String(width.value)
  if (height.value) q.height = String(height.value)
  if (width.value || height.value) q.fit = fit.value
  if (format.value !== 'original') q.format = format.value
  if (quality.value !== null) q.quality = String(quality.value)
  if (rotateDeg.value) q.rotate = String(rotateDeg.value)
  if (flip.value) q.flip = flip.value
  if (crop.value) {
    q.cropLeft = String(crop.value.left)
    q.cropTop = String(crop.value.top)
    q.cropWidth = String(crop.value.width)
    q.cropHeight = String(crop.value.height)
  }
  if (grayscale.value) q.grayscale = 'true'
  if (blur.value !== null) q.blur = String(blur.value)
  if (sharpen.value) q.sharpen = 'true'
  return q
}

const queryString = computed(() => new URLSearchParams(buildQuery()).toString())
const hasEdits = computed(() => queryString.value.length > 0)

// --- Live preview - refetches the transformed content on every param
// change (debounced), same content route the row/slideover thumbnails
// already use (files.vue), just with whatever params are currently set. ---
const previewUrl = ref<string | null>(null)
const previewBlob = ref<Blob | null>(null)
const previewLoading = ref(false)
let previewObjectUrl: string | null = null
let refreshTimer: ReturnType<typeof setTimeout> | undefined

function revokePreview() {
  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl)
    previewObjectUrl = null
  }
}

async function refreshPreviewNow() {
  if (!props.file) return
  previewLoading.value = true
  try {
    const qs = queryString.value
    const response = await $fetch.raw(`/api/totalbase/table/files/${props.file.id}${qs ? `?${qs}` : ''}`, {
      baseURL: '',
      responseType: 'blob',
      headers: authHeaders()
    })
    const blob = response._data as Blob
    revokePreview()
    previewObjectUrl = URL.createObjectURL(blob)
    previewUrl.value = previewObjectUrl
    previewBlob.value = blob
  } catch (err) {
    toast.add({ title: t('content.files.editImage.previewError'), description: err instanceof Error ? err.message : undefined, color: 'error' })
  } finally {
    previewLoading.value = false
  }
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(refreshPreviewNow, 350)
}

watch([width, height, fit, format, quality, rotateDeg, flip, crop, grayscale, blur, sharpen], scheduleRefresh)

// --- Crop tool - cropperjs operates on the full original (not the
// already-transformed preview), since the backend always applies crop
// before every other operation (image-transform.ts) - selecting a
// region against anything else would be selecting against the wrong
// coordinate space. ---
const cropMode = ref(false)
const cropImageEl = ref<HTMLImageElement | null>(null)
const originalUrl = ref<string | null>(null)
let originalObjectUrl: string | null = null
let cropperInstance: Cropper | null = null

async function ensureOriginalLoaded() {
  if (originalUrl.value || !props.file) return
  const response = await $fetch.raw(`/api/totalbase/table/files/${props.file.id}`, {
    baseURL: '',
    responseType: 'blob',
    headers: authHeaders()
  })
  const blob = response._data as Blob
  originalObjectUrl = URL.createObjectURL(blob)
  originalUrl.value = originalObjectUrl
}

function waitForImageLoad(img: HTMLImageElement): Promise<void> {
  if (img.complete && img.naturalWidth > 0) return Promise.resolve()
  return new Promise((resolve) => {
    img.addEventListener('load', () => resolve(), { once: true })
  })
}

async function enterCropMode() {
  await ensureOriginalLoaded()
  cropMode.value = true
  await nextTick()
  const img = cropImageEl.value
  if (!img) return
  await waitForImageLoad(img)

  // cropperjs v2's <cropper-canvas> has no ResizeObserver - it computes
  // the image's internal display transform (screen position/scale ->
  // natural image pixels) exactly once, at connectedCallback, from
  // whatever size the canvas has AT THAT INSTANT. Resizing it via JS
  // *after* construction (an earlier version of this fix) only
  // stretched the already-rendered pixels visually - the crop
  // selection's reported coordinates stayed computed against the old,
  // pre-resize transform, so the applied crop didn't match what was
  // visually selected. The `cropper-canvas` rule in <style> below sets
  // the real size via CSS *before* cropperjs ever runs, so its very
  // first layout pass already uses the correct dimensions - no JS
  // timing to get right.
  const { default: CropperCtor } = await import('cropperjs')
  cropperInstance = new CropperCtor(img, {})
}

function destroyCropper() {
  cropperInstance?.destroy()
  cropperInstance = null
}

function applyCrop() {
  const selection = cropperInstance?.getCropperSelection()
  const cropperCanvas = cropperInstance?.getCropperCanvas()
  const cropperImage = cropperInstance?.getCropperImage()
  const naturalWidth = cropImageEl.value?.naturalWidth ?? 0
  const naturalHeight = cropImageEl.value?.naturalHeight ?? 0

  if (selection && cropperCanvas && cropperImage && naturalWidth > 0 && naturalHeight > 0) {
    // `selection.x/y/width/height` are in <cropper-canvas>'s own CSS
    // pixel space, NOT natural image pixels - confirmed by inspecting
    // cropperjs's source (CropperSelection just mirrors its x/y/width/
    // height attributes 1:1, no natural-pixel conversion happens
    // anywhere). <cropper-image> is also letterboxed/pillarboxed inside
    // the canvas whenever the canvas's aspect ratio doesn't match the
    // source image's (our own `cropper-canvas{width:100%;height:100%}`
    // fill rule guarantees that mismatch in practice, since the drawer
    // area is never exactly the image's aspect ratio) - so converting
    // requires the image's own rendered rect relative to the canvas,
    // not just a flat width/height scale.
    const canvasRect = cropperCanvas.getBoundingClientRect()
    const imageRect = cropperImage.getBoundingClientRect()
    const scale = imageRect.width > 0 ? naturalWidth / imageRect.width : 1
    const imageOffsetX = imageRect.left - canvasRect.left
    const imageOffsetY = imageRect.top - canvasRect.top

    const left = Math.round((selection.x - imageOffsetX) * scale)
    const top = Math.round((selection.y - imageOffsetY) * scale)
    const width = Math.round(selection.width * scale)
    const height = Math.round(selection.height * scale)

    // The selection can extend past the image's own edges (dragged into
    // the letterbox padding, or just past a corner) - clamp to what
    // sharp.extract() can actually satisfy against the real image.
    const clampedLeft = Math.max(0, Math.min(left, naturalWidth - 1))
    const clampedTop = Math.max(0, Math.min(top, naturalHeight - 1))
    crop.value = {
      left: clampedLeft,
      top: clampedTop,
      width: Math.max(1, Math.min(width, naturalWidth - clampedLeft)),
      height: Math.max(1, Math.min(height, naturalHeight - clampedTop))
    }
  }
  destroyCropper()
  cropMode.value = false
}

function cancelCrop() {
  destroyCropper()
  cropMode.value = false
}

function clearCrop() {
  crop.value = null
}

function rotate(delta: 90 | -90) {
  rotateDeg.value = ((rotateDeg.value + delta) % 360 + 360) % 360
}

function toggleFlip(axis: 'horizontal' | 'vertical') {
  flip.value = flip.value === axis ? null : axis
}

// --- URL + copy - the same public content route assets.vue/files.vue
// already build URLs for, with whatever transform params are set. Works
// unauthenticated only if the file is PUBLIC, same existing limitation
// copyUrl() has elsewhere in the admin. ---
const publicUrl = computed(() => {
  if (!props.file) return ''
  const qs = queryString.value
  return `${window.location.origin}/api/totalbase/table/files/${props.file.id}${qs ? `?${qs}` : ''}`
})
async function copyUrl() {
  await navigator.clipboard.writeText(publicUrl.value)
  toast.add({ title: t('common.copied'), color: 'success' })
}

// --- Save as (new file) ---
const isSaveAsOpen = ref(false)
const saveAsName = ref('')
const savingAs = ref(false)
function openSaveAs() {
  if (!props.file) return
  const dot = props.file.name.lastIndexOf('.')
  const base = dot > 0 ? props.file.name.slice(0, dot) : props.file.name
  const ext = dot > 0 ? props.file.name.slice(dot) : ''
  saveAsName.value = `${base} ${t('content.files.editImage.editedSuffix')}${ext}`
  isSaveAsOpen.value = true
}
async function confirmSaveAs() {
  if (!props.file || !previewBlob.value) return
  savingAs.value = true
  try {
    const form = new FormData()
    form.append('file', previewBlob.value, saveAsName.value.trim() || props.file.name)
    form.append('folder', props.file.folder ?? '')
    form.append('visibility', props.file.visibility)
    const data = await filesApi.upload(form)
    toast.add({ title: t('content.files.editImage.savedAsNew'), color: 'success' })
    isSaveAsOpen.value = false
    emit('created', data)
  } catch (err) {
    notifyError(err, t('content.files.editImage.saveError'))
  } finally {
    savingAs.value = false
  }
}

// --- Save and replace (destructive - overwrites the original) ---
const isReplaceOpen = ref(false)
const replaceConfirmed = ref(false)
const replacing = ref(false)
function openReplace() {
  replaceConfirmed.value = false
  isReplaceOpen.value = true
}
async function confirmReplace() {
  if (!props.file || !previewBlob.value) return
  replacing.value = true
  try {
    const form = new FormData()
    form.append('file', previewBlob.value, props.file.name)
    const data = await filesApi.replaceContent(props.file.id, form)
    toast.add({ title: t('content.files.editImage.replaced'), color: 'success' })
    isReplaceOpen.value = false
    emit('replaced', data)
    open.value = false
  } catch (err) {
    notifyError(err, t('content.files.editImage.replaceError'))
  } finally {
    replacing.value = false
  }
}

// --- Replace with a different image entirely (no edits applied - the
// picked file's own bytes go straight in), distinct from "Save and
// replace" above which replaces with the *edited* version of the
// current image. ---
const replaceFileInput = ref<HTMLInputElement | null>(null)
const pickedReplaceFile = ref<File | null>(null)
const isReplaceImageOpen = ref(false)
const replaceImageConfirmed = ref(false)
const replacingImage = ref(false)

function openReplaceImagePicker() {
  replaceFileInput.value?.click()
}

function onReplaceFileSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const picked = input.files?.[0] ?? null
  input.value = '' // allow picking the same filename again later
  if (!picked) return
  pickedReplaceFile.value = picked
  replaceImageConfirmed.value = false
  isReplaceImageOpen.value = true
}

async function confirmReplaceImage() {
  if (!props.file || !pickedReplaceFile.value) return
  replacingImage.value = true
  try {
    const form = new FormData()
    form.append('file', pickedReplaceFile.value, pickedReplaceFile.value.name)
    const data = await filesApi.replaceContent(props.file.id, form)
    toast.add({ title: t('content.files.editImage.replaced'), color: 'success' })
    isReplaceImageOpen.value = false
    pickedReplaceFile.value = null
    emit('replaced', data)
    open.value = false
  } catch (err) {
    notifyError(err, t('content.files.editImage.replaceError'))
  } finally {
    replacingImage.value = false
  }
}

watch(open, (isOpen) => {
  if (isOpen) {
    resetParams()
    previewUrl.value = null
    previewBlob.value = null
    originalUrl.value = null
    cropMode.value = false
    refreshPreviewNow()
  } else {
    destroyCropper()
    revokePreview()
    if (originalObjectUrl) {
      URL.revokeObjectURL(originalObjectUrl)
      originalObjectUrl = null
    }
  }
})

onBeforeUnmount(() => {
  destroyCropper()
  revokePreview()
  if (originalObjectUrl) URL.revokeObjectURL(originalObjectUrl)
})
</script>

<template>
  <AppDrawer
    v-model:open="open"
    :title="file ? t('content.files.editImage.titleFile', { name: file.name }) : t('content.files.editImage.title')"
    :description="t('content.files.editImage.description')"
    size="xl"
  >
    <template #toolbar>
      <div class="flex flex-wrap items-center gap-2">
        <UButton
          :label="cropMode ? t('content.files.editImage.cancelCrop') : t('content.files.editImage.crop')"
          icon="i-lucide-crop"
          color="neutral"
          :variant="cropMode ? 'solid' : 'outline'"
          size="sm"
          @click="cropMode ? cancelCrop() : enterCropMode()"
        />
        <UButton
          v-if="crop"
          :label="t('content.files.editImage.clearCrop')"
          color="neutral"
          variant="ghost"
          size="sm"
          @click="clearCrop"
        />
        <USeparator
          orientation="vertical"
          class="h-6"
        />
        <!-- A toolbar input's label: muted text before it, not a word in the #leading slot (that pads for an icon, and the value would sit under the word). -->
        <div class="flex items-center gap-1.5">
          <span class="text-sm text-muted">{{ t('content.templates.pdfDesigner.width') }}</span>
          <UInput
            v-model.number="width"
            type="number"
            size="sm"
            class="w-20"
            :aria-label="t('content.templates.pdfDesigner.width')"
          />
        </div>
        <div class="flex items-center gap-1.5">
          <span class="text-sm text-muted">{{ t('content.templates.pdfDesigner.height') }}</span>
          <UInput
            v-model.number="height"
            type="number"
            size="sm"
            class="w-20"
            :aria-label="t('content.templates.pdfDesigner.height')"
          />
        </div>
        <USelect
          v-model="fit"
          :aria-label="t('content.files.editImage.fit')"
          :items="FIT_OPTIONS"
          size="sm"
          class="w-28"
        />
        <USeparator
          orientation="vertical"
          class="h-6"
        />
        <UTooltip :text="t('content.files.editImage.rotateLeft')">
          <UButton
            :aria-label="t('content.files.editImage.rotateLeft')"
            icon="i-lucide-rotate-ccw"
            color="neutral"
            variant="outline"
            size="sm"
            square
            @click="rotate(-90)"
          />
        </UTooltip>
        <UTooltip :text="t('content.files.editImage.rotateRight')">
          <UButton
            :aria-label="t('content.files.editImage.rotateRight')"
            icon="i-lucide-rotate-cw"
            color="neutral"
            variant="outline"
            size="sm"
            square
            @click="rotate(90)"
          />
        </UTooltip>
        <UTooltip :text="t('content.files.editImage.flipHorizontal')">
          <UButton
            :aria-label="t('content.files.editImage.flipHorizontal')"
            icon="i-lucide-flip-horizontal-2"
            color="neutral"
            :variant="flip === 'horizontal' ? 'solid' : 'outline'"
            size="sm"
            square
            @click="toggleFlip('horizontal')"
          />
        </UTooltip>
        <UTooltip :text="t('content.files.editImage.flipVertical')">
          <UButton
            :aria-label="t('content.files.editImage.flipVertical')"
            icon="i-lucide-flip-vertical-2"
            color="neutral"
            :variant="flip === 'vertical' ? 'solid' : 'outline'"
            size="sm"
            square
            @click="toggleFlip('vertical')"
          />
        </UTooltip>
        <USeparator
          orientation="vertical"
          class="h-6"
        />
        <USelect
          v-model="format"
          :aria-label="t('content.files.editImage.format')"
          :items="FORMAT_OPTIONS"
          size="sm"
          class="w-32"
        />
        <div class="flex items-center gap-1.5">
          <span class="text-sm text-muted">{{ t('content.files.editImage.quality') }}</span>
          <UInput
            v-model.number="quality"
            type="number"
            :min="1"
            :max="100"
            size="sm"
            class="w-20"
            :aria-label="t('content.files.editImage.quality')"
          />
        </div>
        <UTooltip :text="t('content.files.editImage.grayscale')">
          <UButton
            :aria-label="t('content.files.editImage.grayscale')"
            icon="i-lucide-contrast"
            color="neutral"
            :variant="grayscale ? 'solid' : 'outline'"
            size="sm"
            square
            @click="grayscale = !grayscale"
          />
        </UTooltip>
        <div class="flex items-center gap-1.5">
          <span class="text-sm text-muted">{{ t('content.files.editImage.blur') }}</span>
          <UInput
            v-model.number="blur"
            type="number"
            :min="0.3"
            :max="100"
            size="sm"
            class="w-20"
            :aria-label="t('content.files.editImage.blur')"
          />
        </div>
        <UTooltip :text="t('content.files.editImage.sharpen')">
          <UButton
            :aria-label="t('content.files.editImage.sharpen')"
            icon="i-lucide-sparkles"
            color="neutral"
            :variant="sharpen ? 'solid' : 'outline'"
            size="sm"
            square
            @click="sharpen = !sharpen"
          />
        </UTooltip>
        <UButton
          v-if="hasEdits"
          :label="t('common.reset')"
          color="neutral"
          variant="ghost"
          size="sm"
          @click="resetParams"
        />

        <div class="flex-1" />

        <input
          ref="replaceFileInput"
          type="file"
          accept="image/*"
          class="hidden"
          @change="onReplaceFileSelected"
        >
        <UButton
          :label="t('content.files.editImage.replaceImage')"
          icon="i-lucide-image-up"
          color="neutral"
          variant="outline"
          size="sm"
          @click="openReplaceImagePicker"
        />

        <UPopover v-model:open="isSaveAsOpen">
          <UButton
            :label="t('content.files.editImage.saveAs')"
            icon="i-lucide-copy-plus"
            color="neutral"
            variant="outline"
            size="sm"
            :disabled="!previewBlob"
            @click="openSaveAs"
          />
          <template #content>
            <div class="flex flex-col gap-3 p-4 w-72">
              <p class="text-sm text-muted">
                {{ t('content.files.editImage.saveAsHelp') }}
              </p>
              <UFormField :label="t('content.files.editImage.filename')">
                <UInput
                  v-model="saveAsName"
                  class="w-full"
                />
              </UFormField>
              <div class="flex justify-end gap-2">
                <UButton
                  :label="t('common.cancel')"
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  :disabled="savingAs"
                  @click="isSaveAsOpen = false"
                />
                <UButton
                  :label="t('common.save')"
                  size="sm"
                  :loading="savingAs"
                  :disabled="!saveAsName.trim()"
                  @click="confirmSaveAs"
                />
              </div>
            </div>
          </template>
        </UPopover>

        <UPopover v-model:open="isReplaceOpen">
          <UButton
            :label="t('content.files.editImage.saveAndReplace')"
            icon="i-lucide-save"
            color="error"
            variant="outline"
            size="sm"
            :disabled="!previewBlob"
            @click="openReplace"
          />
          <template #content>
            <div class="flex flex-col gap-3 p-4 w-72">
              <p class="text-sm text-muted">
                {{ t('content.files.editImage.saveAndReplaceHelp') }}
              </p>
              <label class="flex items-center gap-2 cursor-pointer">
                <UCheckbox v-model="replaceConfirmed" />
                <span class="text-sm">{{ t('common.confirm') }}</span>
              </label>
              <div class="flex justify-end gap-2">
                <UButton
                  :label="t('common.cancel')"
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  :disabled="replacing"
                  @click="isReplaceOpen = false"
                />
                <UButton
                  :label="t('content.files.editImage.replace')"
                  color="error"
                  size="sm"
                  :disabled="!replaceConfirmed"
                  :loading="replacing"
                  @click="confirmReplace"
                />
              </div>
            </div>
          </template>
        </UPopover>
      </div>
    </template>

    <div class="flex flex-1 min-h-0 flex-col gap-3">
      <div class="relative flex flex-1 min-h-0 items-center justify-center rounded-lg border border-default bg-elevated/50 overflow-hidden">
        <img
          v-if="cropMode"
          ref="cropImageEl"
          :src="originalUrl ?? undefined"
          alt=""
        >
        <img
          v-else-if="previewUrl"
          :src="previewUrl"
          class="max-h-full max-w-full object-contain"
          alt=""
        >
        <UIcon
          v-else
          name="i-lucide-loader-circle"
          class="size-8 animate-spin text-muted"
        />
        <UEmpty
          v-if="previewLoading && !cropMode"
          loading
          variant="naked"
          size="sm"
        />
      </div>

      <div
        v-if="cropMode"
        class="flex justify-end gap-2 shrink-0"
      >
        <UButton
          :label="t('common.cancel')"
          color="neutral"
          variant="ghost"
          @click="cancelCrop"
        />
        <UButton
          :label="t('content.files.editImage.applyCrop')"
          icon="i-lucide-check"
          @click="applyCrop"
        />
      </div>

      <UFormField
        v-else
        label="URL"
        class="shrink-0"
      >
        <UInput
          :model-value="publicUrl"
          readonly
          class="w-full"
          :ui="{ base: 'font-mono text-xs pr-10' }"
          @focus="($event.target as HTMLInputElement).select()"
        >
          <template #trailing>
            <UTooltip :text="t('content.templates.editor.copyUrl')">
              <UButton
                :aria-label="t('content.templates.editor.copyUrl')"
                icon="i-lucide-copy"
                color="neutral"
                variant="link"
                size="sm"
                :padded="false"
                @click="copyUrl"
              />
            </UTooltip>
          </template>
        </UInput>
      </UFormField>
    </div>

    <!-- A plain UModal rather than the UPopover the other confirmations
    above use - "Replace image"'s trigger opens the OS file picker, not
    this dialog directly, so there's no single anchor element for a
    popover to attach to; this only ever opens itself, once a file has
    actually been picked. -->
    <UModal
      v-model:open="isReplaceImageOpen"
      :title="t('content.files.editImage.replaceImageTitle')"
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <p class="text-sm text-muted">
            <i18n-t
              keypath="content.files.editImage.replaceImageHelp"
              scope="global"
            >
              <template #name>
                <span class="font-medium text-default">{{ pickedReplaceFile?.name }}</span>
              </template>
            </i18n-t>
          </p>
          <div class="flex items-center justify-between gap-2 border-t border-default pt-4">
            <label class="flex items-center gap-2 cursor-pointer">
              <UCheckbox v-model="replaceImageConfirmed" />
              <span class="text-sm">{{ t('common.confirm') }}</span>
            </label>
            <div class="flex gap-2">
              <UButton
                :label="t('common.cancel')"
                color="neutral"
                variant="ghost"
                :disabled="replacingImage"
                @click="isReplaceImageOpen = false"
              />
              <UButton
                :label="t('content.files.editImage.replace')"
                color="error"
                :disabled="!replaceImageConfirmed"
                :loading="replacingImage"
                @click="confirmReplaceImage"
              />
            </div>
          </div>
        </div>
      </template>
    </UModal>
  </AppDrawer>
</template>

<style>
/* cropperjs v2 inserts a <cropper-canvas> custom element dynamically
   (outside Vue's template compiler), so a `scoped` style block can't
   reach it - this has to be a plain global rule. It must already be in
   effect the instant the element connects (see enterCropMode's own
   comment): the canvas otherwise defaults to display:block with only
   min-width:200px/min-height:100px, and cropperjs computes its image
   display transform exactly once at that moment, with no resize
   observer to correct a later JS-driven resize. */
cropper-canvas {
  width: 100% !important;
  height: 100% !important;
}
</style>
