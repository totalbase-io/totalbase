<script setup lang="ts">
/**
 * `UFileUpload` adapter for a COLUMN field whose value is a file id -
 * normally a real foreign key to `totalbase.files(id)` (the ONE widget
 * offered for that FK target, widget-compatibility.ts's own doc comment
 * on why `USelectMenu`/`ForeignKeySelect` can't work there at all: no
 * list route to populate a picker from, Specification_Administration.md §10).
 * Nuxt UI's own `modelValue` is a raw `File | null` (the
 * browser file the user just picked), never what the column actually
 * stores - this adapter uploads it immediately (multipart `POST
 * /api/totalbase/table/files`, the same public Data API every other
 * call in this record form already uses, gated by the viewer's own
 * permission grant on `files` - Security > Roles > Files)
 * and binds the RESULTING file id back onto the column, same "adapter
 * wraps a mismatched modelValue shape" pattern as WidgetInputDate.vue/
 * WidgetInputTime.vue/WidgetPinInput.vue.
 *
 * Deliberately upload-on-pick, not deferred to the record's own Save -
 * `values` elsewhere in this form is a plain JSON object sent straight
 * to the Data API's PATCH/POST body; holding a raw `File` there would
 * need a whole parallel "pending upload" channel resolved inside
 * submit() before the real save, with its own failure mode (upload
 * succeeds, the save after it doesn't - same orphaned-file outcome
 * anyway, just later and more code). Replacing an already-set file does
 * NOT delete the previous file - left as an orphan, cleaned up manually
 * from the Files screen if wanted, rather than a silent delete of
 * something that might still be referenced elsewhere.
 */
import type { FileNode } from '~/types/file'
import { aspectRatio } from '~/utils/photo-capture'

const modelValue = defineModel<string | null | undefined>()
const props = withDefaults(defineProps<{
  /** The empty field's text - unset: the App's ("Drop a file here or click to browse"); the button variant's own text. */
  label?: string
  description?: string
  /** The area variant: a button under its text, for whoever doesn't know the area itself can be tapped. */
  buttonLabel?: string
  disabled?: boolean
  /** Shown, never changed: no remove, no pick - an empty one says so. */
  readonly?: boolean
  accept?: string
  icon?: string | false
  color?: 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'error' | 'neutral'
  variant?: 'area' | 'button'
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  /** An image shows itself across the field, framed in `aspect` - tapping it picks another. */
  preview?: boolean
  aspect?: string
  /** A shown image's height in pixels, whatever the field's width - with `aspect`, its width follows; the empty area's height too. */
  height?: number
}>(), {
  // Unset is no icon choice at all - Vue would read a missing `string | false` as false.
  icon: undefined,
  label: undefined,
  description: undefined,
  buttonLabel: undefined,
  accept: undefined,
  color: undefined,
  variant: undefined,
  size: undefined,
  aspect: undefined,
  height: undefined
})

const dataApi = useDataApi()
// An image shows itself - fetched with the viewer's token, as a PRIVATE file needs (useFileObjectUrl).
const { fileObjectUrl } = useFileObjectUrl()
const { t } = useI18n()
const notifyError = useErrorToast()

const currentFile = ref<FileNode | null>(null)
const loadingCurrent = ref(false)
const loadFailed = ref(false)
const uploading = ref(false)
const pickedFile = ref<File | null>(null)

async function loadCurrent(id: string) {
  loadingCurrent.value = true
  loadFailed.value = false
  try {
    const { data } = await dataApi.get<FileNode>(`/totalbase/table/files/${id}/info`)
    currentFile.value = data
  } catch {
    currentFile.value = null
    loadFailed.value = true
  } finally {
    loadingCurrent.value = false
  }
}

// Re-resolves whenever the underlying value changes - a fresh row
// (create -> another record), an external PATCH, or this widget's own
// upload() below setting it.
watch(() => modelValue.value, (id) => {
  if (id) loadCurrent(id)
  else {
    currentFile.value = null
    loadFailed.value = false
  }
}, { immediate: true })

async function upload(file: File) {
  uploading.value = true
  try {
    const formData = new FormData()
    formData.append('file', file)
    const { data } = await dataApi.post<FileNode>('/totalbase/table/files', formData)
    currentFile.value = data
    modelValue.value = data.id
  } catch (err) {
    notifyError(err, t('dataviews.widgetFileUpload.uploadFailed'))
  } finally {
    uploading.value = false
    pickedFile.value = null
  }
}
watch(pickedFile, (file) => {
  if (file) upload(file)
})

function removeFile() {
  modelValue.value = null
}

const locked = computed(() => props.disabled || props.readonly || uploading.value)
const isImage = computed(() => currentFile.value?.mime_type?.startsWith('image/') === true)
/** Show the image: the file is one, so it takes the field's width instead of a row with its name. */
const showsImage = computed(() => props.preview === true && isImage.value)
const ratio = computed(() => aspectRatio(props.aspect))
/** The shown image's frame: a fixed height (its width from the shape, else the field's), or the shape across the field. */
const frameStyle = computed(() => {
  const height = Number(props.height)
  if (Number.isFinite(height) && height > 0) {
    return ratio.value ? { height: `${height}px`, width: `${Math.round(height * ratio.value)}px`, maxWidth: '100%' } : { height: `${height}px` }
  }
  return ratio.value ? { aspectRatio: String(ratio.value) } : undefined
})
const framed = computed(() => frameStyle.value !== undefined)
const picker = useTemplateRef<HTMLInputElement>('picker')
function pickAnother() {
  if (!locked.value) picker.value?.click()
}
/** The empty area's height (`height`) - to line it up with the cards beside it - with or without Show the image. */
const emptyStyle = computed(() => (props.preview ? frameStyle.value : Number(props.height) > 0 ? { height: `${Number(props.height)}px` } : undefined))
defineExpose({ open: pickAnother })
function onPicked(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  ;(event.target as HTMLInputElement).value = ''
  if (file) upload(file)
}
</script>

<template>
  <div>
    <!-- Show the image: the image itself, across the field - tapping it picks another. -->
    <div
      v-if="modelValue && !loadFailed && showsImage"
      class="relative mx-auto w-full overflow-hidden rounded-lg border border-default bg-elevated"
      :style="frameStyle"
    >
      <button
        type="button"
        class="block size-full"
        :class="locked ? 'cursor-default' : 'cursor-pointer'"
        :disabled="locked"
        :aria-label="t('dataviews.widgetFileUpload.replace')"
        @click="pickAnother"
      >
        <img
          v-if="fileObjectUrl(modelValue, 640)"
          :src="fileObjectUrl(modelValue, 640)"
          :class="['w-full', framed ? 'h-full object-cover' : 'h-auto']"
          :alt="currentFile?.name ?? ''"
        >
        <UIcon
          v-else
          name="i-lucide-loader-circle"
          class="m-auto my-8 block size-6 animate-spin text-muted"
        />
      </button>
      <UButton
        v-if="!readonly"
        icon="i-lucide-x"
        :aria-label="t('dataviews.widgetFileUpload.removeFile')"
        color="neutral"
        variant="solid"
        size="xs"
        class="absolute top-2 right-2"
        :disabled="locked"
        @click="removeFile"
      />
      <UIcon
        v-if="uploading"
        name="i-lucide-loader-circle"
        class="absolute inset-0 m-auto size-6 animate-spin text-inverted"
      />
    </div>

    <!-- A value is set and either resolved or still resolving. -->
    <div
      v-else-if="modelValue && !loadFailed"
      class="flex items-center gap-3 rounded-lg border border-default px-3 py-2"
    >
      <img
        v-if="currentFile?.mime_type?.startsWith('image/') && fileObjectUrl(modelValue, 160)"
        :src="fileObjectUrl(modelValue, 160)"
        class="size-10 shrink-0 rounded-md border border-default object-cover"
        alt=""
      >
      <UIcon
        v-else
        :name="loadingCurrent ? 'i-lucide-loader-circle' : 'i-lucide-file'"
        :class="['size-5 shrink-0 text-muted', loadingCurrent && 'animate-spin']"
      />
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm text-highlighted">
          {{ currentFile?.name ?? t('common.loading') }}
        </p>
        <p
          v-if="currentFile"
          class="truncate text-xs text-muted"
        >
          {{ formatBytes(currentFile.size_bytes) }} · {{ currentFile.mime_type }}
        </p>
      </div>
      <UButton
        v-if="currentFile"
        icon="i-lucide-external-link"
        :to="`/api/totalbase/table/files/${modelValue}`"
        target="_blank"
        :aria-label="t('dataviews.widgetFileUpload.openFile')"
        color="neutral"
        variant="ghost"
        size="xs"
      />
      <UButton
        v-if="!readonly"
        icon="i-lucide-x"
        :aria-label="t('dataviews.widgetFileUpload.removeFile')"
        color="neutral"
        variant="ghost"
        size="xs"
        :disabled="locked"
        @click="removeFile"
      />
    </div>

    <!-- A value is set but its asset row couldn't be resolved (deleted
    out from under it, or a permission gap) - still lets the user clear
    it and pick a new one, rather than getting stuck on a broken value. -->
    <div
      v-else-if="modelValue && loadFailed"
      class="flex items-center gap-2 rounded-lg border border-error/50 bg-error/10 px-3 py-2 text-sm text-error"
    >
      <UIcon
        name="i-lucide-triangle-alert"
        class="size-4 shrink-0"
      />
      <span class="min-w-0 flex-1 truncate">{{ t('dataviews.widgetFileUpload.loadFailed') }}</span>
      <UButton
        v-if="!readonly"
        icon="i-lucide-x"
        :aria-label="t('common.remove')"
        color="error"
        variant="ghost"
        size="xs"
        :disabled="disabled"
        @click="removeFile"
      />
    </div>

    <!-- Read only and empty: nothing to pick. -->
    <p
      v-else-if="readonly"
      class="text-sm text-muted"
    >
      {{ t('dataviews.widgetFileUpload.none') }}
    </p>

    <!-- No value yet, a button with its text: Nuxt UI's button variant is an icon alone. -->
    <UButton
      v-else-if="variant === 'button' && label"
      :label="label"
      :icon="icon === false ? undefined : (icon ?? 'i-lucide-upload')"
      :color="color ?? 'neutral'"
      variant="outline"
      :size="size"
      :loading="uploading"
      :disabled="disabled || uploading"
      @click="pickAnother"
    />

    <!-- No value yet - the real upload dropzone, the height its frame gives it. -->
    <div
      v-else
      class="flex w-full flex-col"
      :style="emptyStyle"
    >
      <UFileUpload
        v-model="pickedFile"
        :disabled="disabled || uploading"
        :loading="uploading"
        :accept="accept"
        :color="color"
        :variant="variant"
        :icon="icon === false ? false : (icon ?? 'i-lucide-upload')"
        :size="size"
        :label="label || t('dataviews.widgetFileUpload.dropzone')"
        :description="description"
        class="w-full flex-1"
      >
        <template
          v-if="buttonLabel"
          #actions="{ open }"
        >
          <UButton
            :label="buttonLabel"
            icon="i-lucide-upload"
            color="neutral"
            variant="outline"
            size="sm"
            :disabled="disabled || uploading"
            @click.stop="open()"
          />
        </template>
      </UFileUpload>
    </div>

    <input
      ref="picker"
      type="file"
      :accept="accept"
      class="hidden"
      @change="onPicked"
    >
  </div>
</template>
