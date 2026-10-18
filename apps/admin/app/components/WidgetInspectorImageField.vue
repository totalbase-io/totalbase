<script setup lang="ts">
/**
 * WidgetInspector.vue's `image` editor (TImage): a file's id or a URL - or
 * one uploaded here, a PUBLIC file, so anyone who opens the page sees it.
 */
import type { WidgetProp } from '@totalbase/tb-catalog'
import type { CatalogColumn } from '~/types/permission'
import type { RelationDefinition } from '~/types/schema'

defineProps<{
  prop: WidgetProp
  value: string | undefined
  /** Its formula binding, shown beside the control. */
  formula: string
  columns?: CatalogColumn[]
  relations?: RelationDefinition[]
}>()
const emit = defineEmits<{
  /** The prop's new value - `undefined` clears it. */
  set: [value: string | undefined]
  setFormula: [formula: string]
}>()
const { t } = useI18n()
const notifyError = useErrorToast()
const dataApi = useDataApi()
const imageInput = useTemplateRef<HTMLInputElement>('imageInput')
const uploadingImage = ref(false)
async function onImagePicked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  uploadingImage.value = true
  try {
    const formData = new FormData()
    formData.append('visibility', 'PUBLIC')
    formData.append('file', file)
    const { data } = await dataApi.post<{ id: string }>('/totalbase/table/files', formData)
    emit('set', data.id)
  } catch (error) {
    notifyError(error, t('designer.inspector.uploadImageFailed'))
  } finally {
    uploadingImage.value = false
  }
}
</script>

<template>
  <UFormField
    :label="prop.label"
    :description="prop.description"
  >
    <div class="flex items-center gap-1">
      <UInput
        :model-value="value ?? ''"
        :aria-label="prop.label"
        class="min-w-0 flex-1 font-mono"
        @update:model-value="emit('set', String($event ?? '').trim() || undefined)"
      />
      <UTooltip :text="t('designer.inspector.uploadImage')">
        <UButton
          icon="i-lucide-upload"
          color="neutral"
          variant="outline"
          :loading="uploadingImage"
          :aria-label="t('designer.inspector.uploadImage')"
          @click="imageInput?.click()"
        />
      </UTooltip>
      <BindingButton
        v-if="prop.binding === 'formula'"
        :model-value="formula"
        kind="value"
        :label="prop.label"
        :columns="columns"
        :relations="relations"
        beside-input
        @update:model-value="emit('setFormula', $event)"
      />
    </div>
    <input
      ref="imageInput"
      type="file"
      accept="image/*"
      class="hidden"
      @change="onImagePicked"
    >
  </UFormField>
</template>
