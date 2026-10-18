<script setup lang="ts">
/**
 * A CUSTOM page's Record table in Settings. One created without it can be
 * given one here - the same choice as the wizard's optional Record step;
 * once set it stays: its form fields are bound to those columns.
 */
import type { DataView } from '~/types/dataview'
import type { Resource } from '~/types/resource'

const props = defineProps<{ dataview: DataView }>()
const emit = defineEmits<{ changed: [] }>()

const { t } = useI18n()
const notifyError = useErrorToast()
const api = useAdminApi()
const hasTable = computed(() => props.dataview.sourceResource !== null)
// Only while it can still be chosen - the shared registry (useResourcesList), not read at all once it has one.
const { resources } = hasTable.value ? { resources: ref<Resource[]>([]) } : useResourcesList()
/** Tables only - a record is written - exposed for reading, as the wizard offers them. */
const tableOptions = computed(() => resources.value
  .filter(r => r.status === 'ACTIVE' && r.type === 'TABLE' && r.exposedMethods.includes('GET'))
  .map(r => ({ label: `${r.schema}.${r.name}`, value: r.id }))
  .sort((a, b) => a.label.localeCompare(b.label)))

const chosen = ref<string | undefined>(undefined)
const saving = ref(false)
async function useTable() {
  if (!chosen.value) return
  saving.value = true
  try {
    await api.patch(`/dataviews/${props.dataview.id}`, { data: { sourceResourceId: chosen.value } })
    emit('changed')
  } catch (err) {
    notifyError(err, t('designer.dataViewRecordTableSettings.setError'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <SettingsSection :title="t('designer.dataViewRecordTableSettings.heading')">
    <UFormField
      v-if="hasTable"
      :label="t('designer.dataViewRecordTableSettings.recordTable')"
      :description="t('designer.dataViewRecordTableSettings.setDescription', { record: 'dataview.vars.record' })"
    >
      <span class="font-mono text-sm">{{ dataview.sourceResourceSchema }}.{{ dataview.sourceResourceName }}</span>
    </UFormField>
    <UFormField
      v-else
      :label="t('designer.dataViewRecordTableSettings.recordTable')"
      :description="t('designer.dataViewRecordTableSettings.chooseDescription', { record: 'dataview.vars.record', pk: '?pk=' })"
    >
      <div class="flex gap-2 max-md:flex-col">
        <USelectMenu
          v-model="chosen"
          :items="tableOptions"
          value-key="value"
          :aria-label="t('designer.dataViewRecordTableSettings.recordTable')"
          class="w-full md:max-w-80"
        />
        <UButton
          :label="t('designer.dataViewRecordTableSettings.useTable')"
          :disabled="!chosen"
          :loading="saving"
          @click="useTable"
        />
      </div>
    </UFormField>
  </SettingsSection>
</template>
