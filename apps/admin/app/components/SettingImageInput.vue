<script setup lang="ts">
/**
 * A setting that holds the id of a PUBLIC image in Files (`system.logo`,
 * `appearance.login_background` - Admin_UI.md §4.1.1): the
 * current image, Upload (a picked file goes straight to Files as PUBLIC,
 * `POST /api/totalbase/table/files`, the way WidgetFileUpload does) and
 * Remove. The setting itself is saved with the page; replacing an image
 * leaves the previous file in Files.
 */
import type { FileNode } from '~/types/file'

const modelValue = defineModel<string>({ required: true })
defineProps<{ label: string }>()

const dataApi = useDataApi()
const { t } = useI18n()
const notifyError = useErrorToast()

const uploading = ref(false)
const picked = ref<File | null>(null)
const previewUrl = computed(() => modelValue.value ? `/api/totalbase/table/files/${modelValue.value}` : null)

watch(picked, async (file) => {
  if (!file) return
  uploading.value = true
  try {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('visibility', 'PUBLIC')
    const { data } = await dataApi.post<FileNode>('/totalbase/table/files', formData)
    modelValue.value = data.id
  } catch (error) {
    notifyError(error, t('settings.appearance.uploadFailed'))
  } finally {
    uploading.value = false
    picked.value = null
  }
})
</script>

<template>
  <div class="flex flex-wrap items-center gap-3">
    <div
      v-if="previewUrl"
      class="flex h-16 max-w-xs items-center rounded-md border border-default bg-muted px-3"
    >
      <img
        :src="previewUrl"
        :alt="label"
        class="max-h-12 w-auto max-w-full object-contain"
      >
    </div>
    <UFileUpload
      v-model="picked"
      accept="image/*"
      variant="button"
      :label="modelValue ? t('settings.appearance.replaceImage') : t('settings.appearance.uploadImage')"
      :disabled="uploading"
      :aria-label="label"
    />
    <UButton
      v-if="modelValue"
      :label="t('common.remove')"
      color="neutral"
      variant="ghost"
      :disabled="uploading"
      @click="modelValue = ''"
    />
  </div>
</template>
