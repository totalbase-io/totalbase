<script setup lang="ts">
import type { EditOperationBody, TableEditPlan } from '~/types/schema'

/**
 * The SQL a table change will run, as it is edited (Administration.md §3.11): the operations are sent to the edit
 * route's preview - the server answers the exact statements without running them, from the same code the save runs -
 * a moment after the last change. Nothing to change says so; a change PostgreSQL's DDL can't be built for says why.
 */
const props = defineProps<{ schema: string, table: string, operations: EditOperationBody[] }>()
const api = useAdminApi()
const { t } = useI18n()
const errorMessage = useApiErrorMessage()

const plan = ref<TableEditPlan | null>(null)
const error = ref<string | null>(null)
const loading = ref(false)
const latest = useLatest()

const key = computed(() => JSON.stringify(props.operations))
let timer: ReturnType<typeof setTimeout> | undefined
watch([key, () => props.schema, () => props.table], () => {
  clearTimeout(timer)
  plan.value = null
  error.value = null
  if (props.operations.length === 0) return
  loading.value = true
  timer = setTimeout(load, 500)
}, { immediate: true })
onBeforeUnmount(() => clearTimeout(timer))

async function load() {
  const request = latest.next()
  try {
    const { data } = await api.post<TableEditPlan>(`/schema/${props.schema}/tables/${props.table}/edit/preview`, { data: { operations: props.operations } })
    if (request.isCurrent()) plan.value = data
  } catch (err) {
    if (request.isCurrent()) error.value = errorMessage(err, t('database.tableEdit.previewError'))
  } finally {
    if (request.isCurrent()) loading.value = false
  }
}

const sql = computed(() => [...(plan.value?.transactional ?? []), ...(plan.value?.concurrent ?? [])].map(statement => `${statement};`).join('\n\n'))
</script>

<template>
  <div class="flex flex-col gap-1">
    <p class="text-xs font-medium text-highlighted">
      {{ t('database.tableEdit.sqlToRun') }}
    </p>
    <p
      v-if="operations.length === 0"
      class="text-sm text-muted"
    >
      {{ t('database.tableEdit.noChanges') }}
    </p>
    <UAlert
      v-else-if="error"
      color="error"
      variant="subtle"
      :title="error"
    />
    <UEmpty
      v-else-if="loading || !plan"
      loading
      variant="naked"
      size="sm"
    />
    <pre
      v-else
      class="text-xs font-mono whitespace-pre-wrap bg-elevated rounded-md p-3 overflow-x-auto max-h-72 overflow-y-auto"
    >{{ sql }}</pre>
  </div>
</template>
