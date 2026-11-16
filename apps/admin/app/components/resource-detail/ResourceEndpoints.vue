<script setup lang="ts">
import type { DataApiMethod, Resource } from '~/types/resource'
import { APPLICABLE_METHODS } from '~/types/resource'
import { endpointPath, methodColor } from '~/utils/resource-endpoints'

/**
 * A resource page's Endpoints (Administration.md §4): one autosaving switch per method its type supports - the
 * Data API's ceiling below role permissions. Extras after the switches go in the slot (a table's idempotency key).
 */
const props = defineProps<{ resource: Resource }>()
const emit = defineEmits<{ 'update:resource': [resource: Resource] }>()
const { t } = useI18n()
const api = useAdminApi()
const notifyError = useErrorToast()

const saving = ref<DataApiMethod | null>(null)
async function toggle(method: DataApiMethod, enabled: boolean) {
  const next = enabled ? [...props.resource.exposedMethods, method] : props.resource.exposedMethods.filter(m => m !== method)
  saving.value = method
  try {
    const { data } = await api.patch<Resource>(`/resources/${props.resource.id}`, { data: { exposedMethods: next } })
    emit('update:resource', data)
    await refreshResourcesList()
  } catch (err) {
    notifyError(err, t('database.resourceDetail.endpointsUpdateError'))
  } finally {
    saving.value = null
  }
}
</script>

<template>
  <SettingsSection :title="t('database.resourceDetail.endpoints')">
    <i18n-t
      :keypath="resource.type === 'TABLE' ? 'database.tableResourceDetail.endpointsIntro' : 'database.resourceDetail.endpointsIntro'"
      tag="p"
      class="text-sm text-muted"
    >
      <template #name>
        <span class="font-medium text-default">{{ resource.schema }}.{{ resource.name }}</span>
      </template>
    </i18n-t>
    <div class="flex flex-col gap-2">
      <div
        v-for="method in APPLICABLE_METHODS[resource.type]"
        :key="method"
        class="flex items-center justify-between gap-3 border border-default rounded-lg px-3 py-2"
      >
        <div class="flex items-center gap-2 min-w-0">
          <UBadge
            :color="methodColor(method)"
            variant="subtle"
            size="sm"
          >
            {{ method }}
          </UBadge>
          <span class="font-mono text-xs text-muted truncate">{{ endpointPath(resource, method) }}</span>
        </div>
        <USwitch
          :model-value="resource.exposedMethods.includes(method)"
          :aria-label="t('database.resourceDetail.exposeMethod', { method })"
          :loading="saving === method"
          @update:model-value="(value: boolean) => toggle(method, value)"
        />
      </div>
      <slot />
    </div>
  </SettingsSection>
</template>
