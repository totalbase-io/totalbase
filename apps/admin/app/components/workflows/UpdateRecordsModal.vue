<script setup lang="ts">
import WorkflowStepKeyField from '~/components/workflows/WorkflowStepKeyField.vue'
/**
 * Configures a `totalbase.update-records` node's `configuration`: a
 * selected exposed TABLE, an optional `where` (same filter-object grammar
 * as Read records/the Data API - AGENTS.md section 7), and `set` - a
 * literal JSON object the author types directly, `{{operation.data.
 * field}}` expressions (apps/server/src/workflow-execution/templates.ts)
 * allowed anywhere inside it - see CreateRecordsModal.vue's own doc
 * comment for why this replaced the earlier structured-Binding picker.
 *
 * Uses UModal, same as ReadRecordsModal.vue/ConditionModal.vue.
 */
import type { RelationDetail } from '~/types/schema'

export interface UpdateRecordsConfiguration {
  resource?: string
  where?: Record<string, unknown>
  set?: unknown
  emitEvents?: boolean
}

const props = defineProps<{ modelValue: UpdateRecordsConfiguration, nodeKey: string, existingKeys: string[] }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ save: [{ key: string, configuration: UpdateRecordsConfiguration }] }>()
const keyValue = ref('')
const keyValid = computed(() => keyValue.value.length > 0 && keyValue.value !== 'start' && keyValue.value !== 'item' && !props.existingKeys.includes(keyValue.value))
const emitEvents = ref(false)

const api = useAdminApi()

const { resources } = useResourcesList()
const resourceOptions = computed(() =>
  (resources.value ?? [])
    .filter(r => r.status === 'ACTIVE' && r.type === 'TABLE' && r.exposedMethods.includes('PATCH'))
    .map(r => ({ label: `${r.schema}.${r.name}`, value: r.id }))
    .sort((a, b) => a.label.localeCompare(b.label)))

const resourceId = ref<string | undefined>(undefined)
const columnsLoading = ref(false)
const columns = ref<RelationDetail['columns']>([])
const whereJson = ref('{}')
const setJson = ref('{}')

// Same "seeding" guard as ReadRecordsModal.vue - without it, reopening for
// a different node than the one last edited looks like a live resource
// switch to the watcher below, which would reset the just-seeded where/set
// back to their empty defaults before the modal ever rendered them.
const seeding = ref(false)
watch(resourceId, async (id, previousId) => {
  if (!seeding.value && previousId !== undefined && id !== previousId) {
    whereJson.value = '{}'
    setJson.value = '{}'
  }
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
  setJson.value = JSON.stringify(props.modelValue.set ?? {}, null, 2)
  emitEvents.value = props.modelValue.emitEvents ?? false
  await nextTick()
  seeding.value = false
})

const whereError = computed(() => jsonError(whereJson.value))
const setError = computed(() => jsonError(setJson.value))

function save() {
  if (setError.value) return
  let where: Record<string, unknown> | undefined
  if (!whereError.value) {
    const parsed = JSON.parse(whereJson.value)
    if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) where = parsed
  }
  emit('save', { key: keyValue.value, configuration: { resource: resourceId.value, where, set: JSON.parse(setJson.value), emitEvents: emitEvents.value } })
  open.value = false
}
// A phone or tablet gets this editor fullscreen (AGENTS.md section 25, modals).
const isCompact = useCompactUi()
</script>

<template>
  <UModal
    v-model:open="open"
    :fullscreen="isCompact"
    :title="$t('workflows.updateRecordsModal.updateRecords')"
    :description="$t('workflows.updateRecordsModal.modifyASelectionUsingThe')"
    :ui="{ content: isCompact ? undefined : 'max-w-2xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <WorkflowStepKeyField
          v-model="keyValue"
          :existing-keys="existingKeys"
        />

        <UFormField
          :label="$t('workflows.updateRecordsModal.resource')"
          required
          :description="$t('workflows.updateRecordsModal.onlyActiveTableResourcesWritable')"
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
          <template v-else>
            <WhereField
              v-model="whereJson"
              :label="$t('workflows.updateRecordsModal.filterWhere')"
              :description="$t('workflows.updateRecordsModal.whichRowsToUpdateRequired', { c0: '{{stepKey.data.field}}', c1: '{{start.data...}}' })"
              :columns="columns"
              :error="whereError ?? undefined"
              default-mode="simple"
            />

            <UFormField
              :label="$t('workflows.updateRecordsModal.set')"
              :description="$t('workflows.updateRecordsModal.aJsonObjectColumnNames', { c0: '{{stepKey.data.field}}', c1: '{{start.data...}}' })"
              :error="setError ?? undefined"
            >
              <JsonEditor
                v-model="setJson"
                min-height="8rem"
              />
            </UFormField>
          </template>
        </template>

        <UFormField
          :label="$t('workflows.updateRecordsModal.emitDatabaseEvents')"
          :description="$t('workflows.updateRecordsModal.letThisStepSUpdates')"
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
          :disabled="!resourceId || !keyValid || !!setError"
          @click="save"
        />
      </div>
    </template>
  </UModal>
</template>
