<script setup lang="ts">
import type { Resource } from '~/types/resource'
import type { RelationDetail } from '~/types/schema'

/**
 * A resource's auditing (Security.md §11, §11.4): every
 * CREATE/UPDATE/DELETE and EXECUTE is audited - writes whole, the row and an
 * UPDATE's old and new of every column it changed. Here: whether a READ
 * writes an entry too (TABLE and VIEW; off by default - it's the volume),
 * and a TABLE's columns kept out of the log. Every control saves at once.
 *
 * Mount it with `:key="resource.id"`: the column list is the one
 * ResourceColumns already loaded (`table-columns-<id>`), read by that fixed key.
 */
const props = defineProps<{ resource: Resource }>()
const emit = defineEmits<{ 'update:resource': [resource: Resource] }>()

const api = useAdminApi()
const { t } = useI18n()
const notifyError = useErrorToast()
const isTable = computed(() => props.resource.type === 'TABLE')

// --- Audit reads ---
const savingRead = ref(false)
async function toggleAuditRead(enabled: boolean) {
  savingRead.value = true
  try {
    const { data } = await api.patch<Resource>(`/resources/${props.resource.id}`, { data: { auditRead: enabled } })
    emit('update:resource', data)
  } catch (err) {
    notifyError(err, t('database.resourceAuditing.updateError'))
  } finally {
    savingRead.value = false
  }
}
// How long entries stay - the warning names the setting's value, not a fixed number.
const { data: auditSettings } = useAsyncData(
  'resource-auditing-settings',
  () => api.get<Record<string, unknown>>('/settings/audit').then(r => r.data),
  { lazy: true, server: false }
)
const retentionDays = computed(() => Number(auditSettings.value?.['audit.retention_days'] ?? 365))

// --- Excluded columns (TABLE only) ---
// Its own read of the table's columns - nothing else on the page loads them under a key to share.
const { data: tableDetail } = useAsyncData(
  `resource-audit-columns-${props.resource.id}`,
  () => isTable.value ? api.get<RelationDetail>(`/catalog/table/${props.resource.postgresOid}`).then(r => r.data) : Promise.resolve(null),
  { lazy: true, server: false }
)
const columnNames = computed(() => (tableDetail.value?.columns ?? []).map(c => c.name))

const { data: excludedFields, pending: exclusionsPending } = await useAsyncData(
  `resource-audit-${props.resource.id}`,
  async () => isTable.value
    ? (await api.get<{ excludedFields: string[] }>(`/resources/${props.resource.id}/audit`)).data.excludedFields
    : [],
  { default: () => [] as string[] }
)

// Each change saves the whole list; only the latest answer is applied.
const savingExclusions = ref(false)
let saveSequence = 0
async function saveExclusions(fields: string[]) {
  const previous = excludedFields.value
  excludedFields.value = fields
  const sequence = ++saveSequence
  savingExclusions.value = true
  try {
    const { data } = await api.put<{ excludedFields: string[] }>(`/resources/${props.resource.id}/audit`, { data: { excludedFields: fields } })
    if (sequence === saveSequence) excludedFields.value = data.excludedFields
  } catch (err) {
    if (sequence === saveSequence) excludedFields.value = previous
    notifyError(err, t('database.resourceAuditing.columnsUpdateError'))
  } finally {
    if (sequence === saveSequence) savingExclusions.value = false
  }
}
</script>

<template>
  <SettingsSection :title="t('database.resourceAuditing.title')">
    <i18n-t
      v-if="resource.type === 'FUNCTION'"
      keypath="database.resourceAuditing.functionIntro"
      tag="p"
      class="text-sm text-muted"
    >
      <template #name>
        <span class="font-medium text-default">{{ resource.schema }}.{{ resource.name }}</span>
      </template>
    </i18n-t>
    <p
      v-else
      class="text-sm text-muted"
    >
      {{ t('database.resourceAuditing.intro') }}
    </p>

    <div
      v-if="resource.type !== 'FUNCTION'"
      class="flex items-center justify-between gap-3 border border-default rounded-lg px-3 py-2"
    >
      <div class="min-w-0">
        <p class="text-sm font-medium">
          {{ t('database.resourceAuditing.auditReads') }}
        </p>
        <p class="text-xs text-muted">
          {{ t('database.resourceAuditing.auditReadsDescription') }}
        </p>
      </div>
      <USwitch
        :model-value="resource.auditRead"
        :aria-label="t('database.resourceAuditing.auditReads')"
        :loading="savingRead"
        @update:model-value="toggleAuditRead"
      />
    </div>

    <UAlert
      v-if="resource.type !== 'FUNCTION' && resource.auditRead"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t('database.resourceAuditing.readsWarningTitle')"
    >
      <template #description>
        <i18n-t
          keypath="database.resourceAuditing.readsWarning"
          scope="global"
        >
          <template #days>
            {{ t('database.resourceAuditing.days', retentionDays) }}
          </template>
          <template #retention>
            <ULink
              to="/settings/audit"
              class="underline"
            >{{ t('database.resourceAuditing.retentionLink') }}</ULink>
          </template>
          <template #maintenance>
            <ULink
              to="/settings/maintenance"
              class="underline"
            >{{ t('database.resourceAuditing.maintenanceLink') }}</ULink>
          </template>
        </i18n-t>
      </template>
    </UAlert>

    <template v-if="isTable">
      <UEmpty
        v-if="exclusionsPending"
        loading
        variant="naked"
        size="sm"
      />
      <UFormField
        v-else
        :label="t('database.resourceAuditing.excludedColumns')"
        :description="t('database.resourceAuditing.excludedColumnsDescription')"
      >
        <USelectMenu
          :model-value="excludedFields"
          multiple
          :items="columnNames"
          :aria-label="t('database.resourceAuditing.excludedColumns')"
          :loading="savingExclusions"
          class="w-full"
          @update:model-value="saveExclusions"
        />
      </UFormField>
    </template>
  </SettingsSection>
</template>
