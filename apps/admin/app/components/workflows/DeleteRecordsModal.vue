<script setup lang="ts">
import WorkflowStepKeyField from '~/components/workflows/WorkflowStepKeyField.vue'
/**
 * Configures a `totalbase.delete-records` node's `configuration`: a
 * selected exposed TABLE plus an optional `where` (same filter-object
 * grammar as Read/Update records). Like the Data API's DELETE, an empty
 * filter is refused - at publish and at run time - while
 * `api.require_where_for_delete` is on (Specification_Workflows.md §5.5).
 *
 * Uses UModal, same as ReadRecordsModal.vue/ConditionModal.vue.
 */
import type { RelationDetail } from '~/types/schema'

export interface DeleteRecordsConfiguration {
  resource?: string
  where?: Record<string, unknown>
  emitEvents?: boolean
}

const props = defineProps<{ modelValue: DeleteRecordsConfiguration, nodeKey: string, existingKeys: string[] }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ save: [{ key: string, configuration: DeleteRecordsConfiguration }] }>()
const keyValue = ref('')
const keyValid = computed(() => keyValue.value.length > 0 && keyValue.value !== 'start' && keyValue.value !== 'item' && !props.existingKeys.includes(keyValue.value))
const emitEvents = ref(false)

const api = useAdminApi()

const { resources } = useResourcesList()
const resourceOptions = computed(() =>
  (resources.value ?? [])
    .filter(r => r.status === 'ACTIVE' && r.type === 'TABLE' && r.exposedMethods.includes('DELETE'))
    .map(r => ({ label: `${r.schema}.${r.name}`, value: r.id }))
    .sort((a, b) => a.label.localeCompare(b.label)))

const resourceId = ref<string | undefined>(undefined)
const columnsLoading = ref(false)
const columns = ref<RelationDetail['columns']>([])
const whereJson = ref('{}')

// Same "seeding" guard as ReadRecordsModal.vue/UpdateRecordsModal.vue.
const seeding = ref(false)
watch(resourceId, async (id, previousId) => {
  if (!seeding.value && previousId !== undefined && id !== previousId) whereJson.value = '{}'
  columns.value = []
  const resource = resources.value?.find(r => r.id === id)
  if (!resource) return
  columnsLoading.value = true
  try {
    const { data } = await api.get<RelationDetail>(`/catalog/table/${resource.postgresOid}`)
    columns.value = data.columns
  } finally {
    columnsLoading.value = false
  }
})

watch(open, async (value) => {
  if (!value) return
  seeding.value = true
  keyValue.value = props.nodeKey
  resourceId.value = props.modelValue.resource
  whereJson.value = JSON.stringify(props.modelValue.where ?? {}, null, 2)
  emitEvents.value = props.modelValue.emitEvents ?? false
  await nextTick()
  seeding.value = false
})

const whereError = computed(() => jsonError(whereJson.value))

function save() {
  let where: Record<string, unknown> | undefined
  if (!whereError.value) {
    const parsed = JSON.parse(whereJson.value)
    if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) where = parsed
  }
  emit('save', { key: keyValue.value, configuration: { resource: resourceId.value, where, emitEvents: emitEvents.value } })
  open.value = false
}
// A phone or tablet gets this editor fullscreen (AGENTS.md section 25, modals).
const isCompact = useCompactUi()
</script>

<template>
  <UModal
    v-model:open="open"
    :fullscreen="isCompact"
    :title="$t('workflows.deleteRecordsModal.deleteRecords')"
    :description="$t('workflows.deleteRecordsModal.deleteASelectionUsingThe')"
    :ui="{ content: isCompact ? undefined : 'max-w-2xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <WorkflowStepKeyField
          v-model="keyValue"
          :existing-keys="existingKeys"
        />

        <UFormField
          :label="$t('workflows.deleteRecordsModal.resource')"
          required
          :description="$t('workflows.deleteRecordsModal.onlyActiveTableResourcesWritable')"
        >
          <USelectMenu
            v-model="resourceId"
            :items="resourceOptions"
            value-key="value"
            searchable
            class="w-full"
          />
        </UFormField>

        <template v-if="resourceId">
          <UEmpty
            v-if="columnsLoading"
            loading
            variant="naked"
            size="sm"
          />
          <WhereField
            v-else
            v-model="whereJson"
            :label="$t('workflows.deleteRecordsModal.filterWhere')"
            :description="$t('workflows.deleteRecordsModal.whichRowsToDeleteRequired', { c0: '{{stepKey.data.field}}', c1: '{{start.data...}}' })"
            :columns="columns"
            :error="whereError ?? undefined"
            default-mode="simple"
          />
        </template>

        <UFormField
          :label="$t('workflows.deleteRecordsModal.emitDatabaseEvents')"
          :description="$t('workflows.deleteRecordsModal.letThisStepSDeletions')"
        >
          <USwitch v-model="emitEvents" />
        </UFormField>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :label="$t('common.cancel')"
          @click="open = false"
        />
        <UButton
          :label="$t('common.save')"
          color="error"
          :disabled="!resourceId || !keyValid"
          @click="save"
        />
      </div>
    </template>
  </UModal>
</template>
