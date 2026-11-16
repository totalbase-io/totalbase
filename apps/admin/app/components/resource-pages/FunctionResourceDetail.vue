<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { FunctionClass, Resource } from '~/types/resource'
import type { FunctionDetail, FunctionParameter } from '~/types/schema'

/** FUNCTION detail rendered by the canonical resource route (its TotalBase UUID, stable across renames). */
const route = useRoute()
const api = useAdminApi()
const resourcesApi = useResourcesApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()
const resourceId = computed(() => route.params.id as string)

const PARAMETER_COLUMNS = computed<TableColumn<FunctionParameter>[]>(() => [
  { accessorKey: 'name', header: t('common.name') },
  { accessorKey: 'dataType', header: t('common.type') },
  { id: 'required', header: t('common.required') }
])

const { data: resource, pending, error } = await useAsyncData(
  () => `function-detail-${resourceId.value}`,
  () => resourcesApi.get(resourceId.value),
  { watch: [resourceId] }
)
// Its parameters, what it returns and who owns it (Administration.md §3.15).
const { data: detail, pending: detailPending, error: detailError } = await useAsyncData(
  () => `function-definition-${resourceId.value}`,
  () => api.get<FunctionDetail>(`/catalog/function/${resourceId.value}`).then(r => r.data),
  { watch: [resourceId] }
)

// --- Function class (TotalBase's own metadata, autosaved like the description and the endpoints) ---
const FUNCTION_CLASS_OPTIONS: FunctionClass[] = ['UNCLASSIFIED', 'QUERY', 'ACTION']
const savingClass = ref(false)
async function saveFunctionClass(functionClass: FunctionClass) {
  if (!resource.value || functionClass === (resource.value.functionClass ?? 'UNCLASSIFIED')) return
  savingClass.value = true
  try {
    const { data } = await api.patch<Resource>(`/resources/${resource.value.id}`, { data: { functionClass } })
    resource.value = data
    toast.add({ title: t('database.functionDetail.classUpdated'), color: 'success' })
  } catch (err) {
    notifyError(err, t('database.functionDetail.classUpdateError'))
  } finally {
    savingClass.value = false
  }
}
</script>

<template>
  <ResourceDetailShell
    :resource="resource"
    :pending="pending"
    :error="error"
    :load-error="t('database.functionResourceDetail.loadError')"
  >
    <template #default="{ resource: fn }">
      <ResourceDataSection
        :resource="fn"
        :rename-hint="t('database.functionResourceDetail.renameHint')"
        @update:resource="next => resource = next"
      >
        <UFormField
          :label="t('database.functionDetail.functionClass')"
          :description="t('database.functionResourceDetail.classDescription')"
        >
          <USelect
            :model-value="fn.functionClass ?? 'UNCLASSIFIED'"
            :items="FUNCTION_CLASS_OPTIONS"
            :loading="savingClass"
            class="w-full"
            @update:model-value="(value: FunctionClass) => saveFunctionClass(value)"
          />
        </UFormField>
      </ResourceDataSection>

      <div>
        <ResourceEditSqlButton
          :resource="fn"
          :label="t('database.functionResourceDetail.editFunction')"
        />
      </div>

      <SettingsSection :title="t('database.functionDetail.parameters')">
        <template #actions>
          <UBadge
            v-if="detail"
            :color="detail.returnsRows ? 'success' : 'neutral'"
            variant="subtle"
            size="sm"
          >
            {{ detail.returnsRows ? t('database.functionResourceDetail.returnsRows') : t('database.functionResourceDetail.scalarReturn') }}
          </UBadge>
        </template>
        <UAlert
          v-if="detailError"
          color="error"
          variant="subtle"
          :title="detailError.message"
        />
        <UEmpty
          v-else-if="detailPending"
          loading
          variant="naked"
          size="sm"
        />
        <UTable
          v-else-if="detail?.parameters.length"
          sticky
          :data="detail.parameters"
          :columns="PARAMETER_COLUMNS"
        >
          <template #name-cell="{ row }">
            <span class="font-medium text-highlighted">{{ row.original.name }}</span>
          </template>
          <template #dataType-cell="{ row }">
            <span class="font-mono text-xs">{{ row.original.dataType }}</span>
          </template>
          <template #required-cell="{ row }">
            {{ row.original.hasDefault ? t('common.no') : t('common.yes') }}
          </template>
        </UTable>
        <p
          v-else
          class="text-sm text-muted"
        >
          {{ t('database.functionResourceDetail.noParameters') }}
        </p>
      </SettingsSection>

      <ResourceEndpoints
        :resource="fn"
        @update:resource="next => resource = next"
      />

      <ResourceAuditing
        :key="fn.id"
        :resource="fn"
        @update:resource="next => resource = next"
      />

      <ResourceDangerZone
        :resource="fn"
        :ownership="detail ? { owner: detail.owner, canAlter: detail.canAlter } : null"
      />
    </template>
  </ResourceDetailShell>
</template>
