<script setup lang="ts">
import type { Resource } from '~/types/resource'

/**
 * A resource's description (TotalBase's own metadata, not a PostgreSQL COMMENT ON), autosaved on blur. The draft
 * resets only when the resource itself changes, not on the re-fetch its own save causes - typing would race the PATCH.
 */
const props = defineProps<{ resource: Resource }>()
const emit = defineEmits<{ 'update:resource': [resource: Resource] }>()
const { t } = useI18n()
const api = useAdminApi()
const notifyError = useErrorToast()

const draft = ref(props.resource.description ?? '')
watch(() => props.resource.id, () => {
  draft.value = props.resource.description ?? ''
})
const saving = ref(false)
async function save() {
  const next = draft.value.trim() === '' ? null : draft.value.trim()
  if (next === props.resource.description) return
  saving.value = true
  try {
    const { data } = await api.patch<Resource>(`/resources/${props.resource.id}`, { data: { description: next } })
    emit('update:resource', data)
  } catch (err) {
    notifyError(err, t('database.resourceDetail.descriptionUpdateError'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div>
    <p class="text-sm font-medium mb-1">
      {{ t('common.description') }}
    </p>
    <UTextarea
      v-model="draft"
      :aria-label="t('common.description')"
      :rows="2"
      class="w-full"
      :disabled="saving"
      @blur="save"
    />
  </div>
</template>
