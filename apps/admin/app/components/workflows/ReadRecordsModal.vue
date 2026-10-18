<script setup lang="ts">
import WorkflowStepKeyField from '~/components/workflows/WorkflowStepKeyField.vue'
/**
 * Configures a `totalbase.read-records` node's `configuration` (Specification_Workflows.md §5.2):
 * a selected exposed TABLE/readable VIEW
 * plus the Data API query object, edited via the shared QueryBuilder.vue
 * (same grammar the Data API's own GET query string uses - 23.1: "does
 * not... create a separate read/filter language").
 *
 * Uses UModal, same as ConditionModal.vue (AGENTS.md-adjacent convention:
 * operation configuration in this editor is a modal, not a drawer).
 */
import type { RelationDetail } from '~/types/schema'
import type { QueryObject } from '~/components/QueryBuilder.vue'

export interface ReadRecordsConfiguration {
  resource?: string
  query?: QueryObject
}

const props = defineProps<{ modelValue: ReadRecordsConfiguration, nodeKey: string, existingKeys: string[] }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ save: [{ key: string, configuration: ReadRecordsConfiguration }] }>()
const keyValue = ref('')
const keyValid = computed(() => keyValue.value.length > 0 && keyValue.value !== 'start' && keyValue.value !== 'item' && !props.existingKeys.includes(keyValue.value))

const api = useAdminApi()

const { resources } = useResourcesList()
const resourceOptions = computed(() =>
  (resources.value ?? [])
    .filter(r => r.status === 'ACTIVE' && (r.type === 'TABLE' || r.type === 'VIEW') && r.exposedMethods.includes('GET'))
    .map(r => ({ label: `${r.schema}.${r.name}`, value: r.id }))
    .sort((a, b) => a.label.localeCompare(b.label)))

const resourceId = ref<string | undefined>(undefined)

const columnsLoading = ref(false)
const columns = ref<RelationDetail['columns']>([])
const queryJson = ref('{}')
// Set for the duration of the `open` watcher's own seeding assignment below
// (including the `resourceId` watcher it synchronously triggers) - without
// it, reopening for a DIFFERENT node than the one last edited looked like a
// live "user switched the resource dropdown" edit to the watcher below,
// which reset the just-seeded query back to '{}' before the modal ever
// rendered it. Only an actual in-modal resource switch (seeding false)
// should invalidate the query.
const seeding = ref(false)
watch(resourceId, async (id, previousId) => {
  if (!seeding.value && previousId !== undefined && id !== previousId) queryJson.value = '{}'
  columns.value = []
  const resource = resources.value?.find(r => r.id === id)
  if (!resource) return
  columnsLoading.value = true
  try {
    const kind = resource.type === 'VIEW' ? 'view' : 'table'
    const { data } = await api.get<RelationDetail>(`/catalog/${kind}/${resource.postgresOid}`)
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
  queryJson.value = JSON.stringify(props.modelValue.query ?? {}, null, 2)
  await nextTick()
  seeding.value = false
})

const queryError = computed(() => jsonError(queryJson.value))

function save() {
  let query: QueryObject | undefined
  if (!queryError.value) {
    const parsed = JSON.parse(queryJson.value)
    if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) query = parsed
  }
  emit('save', { key: keyValue.value, configuration: { resource: resourceId.value, query } })
  open.value = false
}
// A phone or tablet gets this editor fullscreen (AGENTS.md section 25, modals).
const isCompact = useCompactUi()
</script>

<template>
  <UModal
    v-model:open="open"
    :fullscreen="isCompact"
    :title="$t('workflows.readRecordsModal.readRecords')"
    :description="$t('workflows.readRecordsModal.queryAResourceUsingThe')"
    :ui="{ content: isCompact ? undefined : 'max-w-2xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <WorkflowStepKeyField
          v-model="keyValue"
          :existing-keys="existingKeys"
        />

        <UFormField
          :label="$t('workflows.readRecordsModal.resource')"
          required
          :description="$t('workflows.readRecordsModal.onlyActiveTableViewResources')"
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
          <QueryBuilder
            v-else
            v-model="queryJson"
            :label="$t('workflows.readRecordsModal.query')"
            :description="$t('workflows.readRecordsModal.fieldsFilterSearchGroupingOrdering', { c0: '{{stepKey.data.field}}', c1: '{{start.data...}}' })"
            :columns="columns"
          />
        </template>
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
          :disabled="!resourceId || !keyValid"
          @click="save"
        />
      </div>
    </template>
  </UModal>
</template>
