<script setup lang="ts">
import type { FunctionClass, Resource } from '~/types/resource'
import type { TableColumn } from '@nuxt/ui'
import type { FunctionDetail, FunctionParameter } from '~/types/schema'

const FUNCTION_CLASS_OPTIONS: FunctionClass[] = ['UNCLASSIFIED', 'QUERY', 'ACTION']

const props = defineProps<{ resource: Resource }>()
const emit = defineEmits<{ classified: [functionClass: FunctionClass] }>()

const api = useAdminApi()

const PARAMETER_COLUMNS = computed<TableColumn<FunctionParameter>[]>(() => [
  { accessorKey: 'name', header: t('common.name') },
  { accessorKey: 'dataType', header: t('common.type') },
  { id: 'required', header: t('common.required') }
])
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()

const { data: detail, pending, error } = await useAsyncData(
  () => `function-${props.resource.id}`,
  () => api.get<FunctionDetail>(`/catalog/function/${props.resource.id}`).then(r => r.data),
  { watch: [() => props.resource.id] }
)

const { data: ddl, pending: ddlPending } = await useAsyncData(
  () => `function-${props.resource.id}-ddl`,
  () => api.get<{ ddl: string }>(`/catalog/function/${props.resource.id}/ddl`).then(r => r.data.ddl),
  { watch: [() => props.resource.id] }
)

const draftFunctionClass = ref<FunctionClass>(props.resource.functionClass ?? 'UNCLASSIFIED')
watch(() => props.resource, (r) => {
  draftFunctionClass.value = r.functionClass ?? 'UNCLASSIFIED'
})
const savingClass = ref(false)

async function saveFunctionClass() {
  savingClass.value = true
  try {
    const { data } = await api.patch<Resource>(`/resources/${props.resource.id}`, {
      data: { functionClass: draftFunctionClass.value }
    })
    emit('classified', data.functionClass ?? 'UNCLASSIFIED')
    toast.add({ title: t('database.functionDetail.classUpdated'), color: 'success' })
  } catch (err) {
    notifyError(err, t('database.functionDetail.classUpdateError'))
  } finally {
    savingClass.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <UCard>
      <template #header>
        <span class="font-medium">{{ t('database.functionDetail.classification') }}</span>
      </template>
      <UFormField
        :label="t('database.functionDetail.functionClass')"
        :description="t('database.functionDetail.classDescription')"
      >
        <div class="flex gap-2">
          <USelect
            v-model="draftFunctionClass"
            :items="FUNCTION_CLASS_OPTIONS"
            class="flex-1"
          />
          <UButton
            :label="t('common.save')"
            :loading="savingClass"
            :disabled="draftFunctionClass === (resource.functionClass ?? 'UNCLASSIFIED')"
            @click="saveFunctionClass"
          />
        </div>
      </UFormField>
    </UCard>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="error.message"
    />

    <UEmpty
      v-if="pending"
      loading
      variant="naked"
      size="sm"
    />

    <template v-else-if="detail">
      <div class="flex items-center gap-2 text-sm">
        <span class="text-muted">{{ t('database.functionDetail.returnType') }}</span>
        <UBadge
          :color="detail.returnsRows ? 'success' : 'neutral'"
          variant="subtle"
          size="sm"
        >
          {{ detail.returnsRows ? t('database.functionDetail.tableSet') : t('database.functionDetail.scalar') }}
        </UBadge>
      </div>

      <div v-if="detail.parameters.length">
        <p class="text-sm text-muted mb-1">
          {{ t('database.functionDetail.parameters') }}
        </p>
        <UTable
          sticky
          :data="detail.parameters"
          :columns="PARAMETER_COLUMNS"
        >
          <template #name-cell="{ row }">
            <span class="font-mono font-medium text-highlighted">{{ row.original.name }}</span>
          </template>
          <template #dataType-cell="{ row }">
            <span class="font-mono">{{ row.original.dataType }}</span>
          </template>
          <template #required-cell="{ row }">
            {{ row.original.hasDefault ? t('common.no') : t('common.yes') }}
          </template>
        </UTable>
      </div>

      <div>
        <p class="text-sm text-muted mb-1">
          {{ t('database.functionDetail.definition') }}
        </p>
        <UEmpty
          v-if="ddlPending"
          loading
          variant="naked"
          size="sm"
        />
        <ReadonlyCodeViewer
          v-else
          :code="ddl ?? ''"
        />
      </div>
    </template>
  </div>
</template>
