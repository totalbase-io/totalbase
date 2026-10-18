<script setup lang="ts">
import type { Resource } from '~/types/resource'

/**
 * "Require an idempotency key" (Specification_Data_API.md §9.1) - a row
 * under a TABLE's or a FUNCTION's endpoint switches: its write (CREATE /
 * EXECUTE) never runs without an Idempotency-Key header. Saves at once.
 */
const props = defineProps<{ resource: Resource }>()
const emit = defineEmits<{ 'update:resource': [resource: Resource] }>()

const api = useAdminApi()
const { t } = useI18n()
const notifyError = useErrorToast()
const saving = ref(false)
const operation = computed(() => props.resource.type === 'FUNCTION' ? t('database.resourceIdempotencyKey.aCall') : t('database.resourceIdempotencyKey.aPost'))

async function toggle(enabled: boolean) {
  saving.value = true
  try {
    const { data } = await api.patch<Resource>(`/resources/${props.resource.id}`, { data: { requireIdempotencyKey: enabled } })
    emit('update:resource', data)
  } catch (err) {
    notifyError(err, t('database.resourceIdempotencyKey.updateError'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="flex items-center justify-between gap-3 border border-default rounded-lg px-3 py-2">
    <div class="min-w-0">
      <p class="text-sm font-medium">
        {{ t('database.resourceIdempotencyKey.title') }}
      </p>
      <i18n-t
        keypath="database.resourceIdempotencyKey.description"
        tag="p"
        class="text-xs text-muted"
      >
        <template #operation>
          {{ operation }}
        </template>
        <template #header>
          <span class="font-mono">Idempotency-Key</span>
        </template>
      </i18n-t>
    </div>
    <USwitch
      :model-value="resource.requireIdempotencyKey"
      :aria-label="t('database.resourceIdempotencyKey.title')"
      :loading="saving"
      @update:model-value="toggle"
    />
  </div>
</template>
