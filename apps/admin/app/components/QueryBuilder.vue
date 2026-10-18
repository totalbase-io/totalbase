<script setup lang="ts">
/**
 * Reusable editor for a Data API query object - the same shape/grammar a
 * GET request's query string produces (`fields`/`order_by`/`search` as
 * comma-separated strings, `where`/`having` as filter-object grammar,
 * `group_by` as string[][], aggregates as `_sum`/`_count`/`_avg`/`_min`/
 * `_max` column->alias maps - see packages/query-engine/src/parser.ts).
 * First consumer: ReadRecordsModal.vue's `totalbase.read-records`
 * configuration; meant to be reused wherever a query needs building
 * (dashboards, other workflow operations).
 *
 * `display` picks how the CURRENT value is shown: 'json' (default) is a
 * raw Monaco JSON editor with Format/Build buttons - 'summary' (a chip-
 * based collapsed view) is deferred until a caller actually needs it
 * (tables with 20+ columns would make a full chip render noisy - the
 * concern that prompted `display` at all - but no caller has hit that
 * yet; 'json' always renders regardless of what's requested until then).
 *
 * The Build modal covers fields/search/where/group by/aggregates/order
 * by (multi-column)/limit/offset/count.
 * `having` is deliberately NOT here yet - it needs its own filter grammar
 * UI against the aggregates' OUTPUT aliases (synthetic columns), which is
 * enough extra complexity to defer to a follow-up.
 */
import type { CatalogColumn } from '~/types/permission'
import { classifyDataType } from '~/utils/filterOperators'

export type QueryBuilderDisplay = 'summary' | 'json'

export interface QueryObject {
  fields?: string
  where?: Record<string, unknown>
  search?: string
  order_by?: string
  group_by?: string[][]
  limit?: number
  offset?: number
  count?: boolean
  _sum?: Record<string, string>
  _count?: Record<string, string>
  _avg?: Record<string, string>
  _min?: Record<string, string>
  _max?: Record<string, string>
}

const AGGREGATE_FUNCTIONS = ['_sum', '_count', '_avg', '_min', '_max'] as const
type AggregateFunction = typeof AGGREGATE_FUNCTIONS[number]
/** `database.queryBuilder.aggregateFunctions.<key>` - the function's name in the UI. */
const AGGREGATE_LABEL_KEYS: Record<AggregateFunction, string> = {
  _sum: 'sum', _count: 'count', _avg: 'avg', _min: 'min', _max: 'max'
}
// Count works on any column; the rest need a numeric column to be meaningful.
function aggregateFunctionsFor(dataType: string | undefined): AggregateFunction[] {
  if (!dataType) return ['_count']
  return classifyDataType(dataType) === 'number' ? [...AGGREGATE_FUNCTIONS] : ['_count']
}

const props = withDefaults(defineProps<{
  label: string
  description?: string | undefined
  columns: CatalogColumn[]
  display?: QueryBuilderDisplay
}>(), {
  description: undefined,
  display: 'json'
})

const jsonText = defineModel<string>({ required: true })
const { t } = useI18n()
const editorRef = ref<{ format: () => void } | null>(null)

const parseError = computed(() => jsonError(jsonText.value || '{}'))

const isBuildOpen = ref(false)

// --- Build modal state, seeded from the current JSON each time it opens ---
const selectedFields = ref<string[]>([])
const whereJson = ref('{}')
const search = ref('')
const groupByColumns = ref<string[]>([])
interface AggregateRow { column: string, fn: AggregateFunction, alias: string }
const aggregateRows = ref<AggregateRow[]>([])
interface OrderByRow { column: string, direction: 'asc' | 'desc' }
const orderByRows = ref<OrderByRow[]>([])
const limit = ref<number | undefined>(undefined)
const offset = ref<number | undefined>(undefined)
const count = ref(false)

function openBuild() {
  let current: QueryObject = {}
  try {
    current = JSON.parse(jsonText.value || '{}')
  } catch {
    current = {}
  }

  selectedFields.value = current.fields ? current.fields.split(',').filter(Boolean) : []
  whereJson.value = JSON.stringify(current.where ?? {}, null, 2)
  search.value = current.search ?? ''
  groupByColumns.value = current.group_by?.[0] ?? []

  aggregateRows.value = []
  for (const fn of AGGREGATE_FUNCTIONS) {
    const map = current[fn]
    if (!map) continue
    for (const [column, alias] of Object.entries(map)) aggregateRows.value.push({ column, fn, alias })
  }

  orderByRows.value = current.order_by
    ? current.order_by.split(',').filter(Boolean).map((part) => {
        const desc = part.startsWith('-')
        return { column: desc ? part.slice(1) : part, direction: desc ? 'desc' : 'asc' as const }
      })
    : []

  limit.value = current.limit
  offset.value = current.offset
  count.value = current.count ?? false

  isBuildOpen.value = true
}

const whereError = computed(() => jsonError(whereJson.value))

function addAggregateRow() {
  const column = props.columns[0]?.name
  if (!column) return
  aggregateRows.value.push({ column, fn: '_count', alias: '' })
}
function removeAggregateRow(index: number) {
  aggregateRows.value.splice(index, 1)
}

function addOrderByRow() {
  const column = props.columns[0]?.name
  if (!column) return
  orderByRows.value.push({ column, direction: 'asc' })
}
function removeOrderByRow(index: number) {
  orderByRows.value.splice(index, 1)
}

function applyBuild() {
  const query: QueryObject = {}
  if (selectedFields.value.length > 0) query.fields = selectedFields.value.join(',')
  if (!whereError.value) {
    const parsed = JSON.parse(whereJson.value)
    if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) query.where = parsed
  }
  if (search.value.trim()) query.search = search.value.trim()
  if (groupByColumns.value.length > 0) query.group_by = [groupByColumns.value]
  for (const row of aggregateRows.value) {
    if (!row.alias.trim()) continue
    query[row.fn] = { ...query[row.fn], [row.column]: row.alias.trim() }
  }
  if (orderByRows.value.length > 0) {
    query.order_by = orderByRows.value.map(r => r.direction === 'desc' ? `-${r.column}` : r.column).join(',')
  }
  if (limit.value !== undefined) query.limit = limit.value
  if (offset.value !== undefined) query.offset = offset.value
  if (count.value) query.count = true

  jsonText.value = JSON.stringify(query, null, 2)
  isBuildOpen.value = false
}
// A phone or tablet gets this editor fullscreen (AGENTS.md section 25, modals).
const isCompact = useCompactUi()
</script>

<template>
  <div>
    <UFormField
      :label="label"
      :description="description"
      :error="parseError ?? undefined"
    >
      <div class="flex items-center justify-end gap-1 pb-2">
        <UButton
          :label="t('database.queryBuilder.build')"
          icon="i-lucide-list-plus"
          size="xs"
          color="neutral"
          variant="ghost"
          @click="openBuild"
        />
        <UButton
          :label="t('database.queryBuilder.format')"
          icon="i-lucide-wand-sparkles"
          size="xs"
          color="neutral"
          variant="ghost"
          @click="editorRef?.format()"
        />
      </div>
      <JsonEditor
        ref="editorRef"
        v-model="jsonText"
        min-height="12rem"
      />
    </UFormField>

    <UModal
      v-model:open="isBuildOpen"
      :fullscreen="isCompact"
      :title="t('database.queryBuilder.buildTitle')"
      :description="t('database.queryBuilder.buildDescription')"
      :ui="{ content: isCompact ? undefined : 'max-w-2xl', body: 'max-h-[70vh] overflow-y-auto' }"
    >
      <template #body>
        <div class="space-y-4">
          <UFormField
            :label="t('database.queryBuilder.fields')"
            :description="t('database.queryBuilder.fieldsDescription')"
          >
            <UCheckboxGroup
              v-model="selectedFields"
              :items="columns.map(c => ({ label: c.name, value: c.name }))"
              :ui="{ fieldset: 'grid grid-flow-col grid-rows-5 gap-x-4 gap-y-1 justify-start' }"
            />
          </UFormField>

          <UFormField
            :label="t('common.search')"
            :description="t('database.queryBuilder.searchDescription')"
          >
            <UInput
              v-model="search"
              class="w-full"
            />
          </UFormField>

          <WhereField
            v-model="whereJson"
            :label="t('database.queryBuilder.where')"
            :description="t('database.queryBuilder.whereDescription')"
            :columns="columns"
            :error="whereError ?? undefined"
            default-mode="simple"
          />

          <UFormField
            :label="t('database.queryBuilder.groupBy')"
            :description="t('database.queryBuilder.groupByDescription')"
          >
            <UCheckboxGroup
              v-model="groupByColumns"
              :items="columns.map(c => ({ label: c.name, value: c.name }))"
              :ui="{ fieldset: 'grid grid-flow-col grid-rows-5 gap-x-4 gap-y-1 justify-start' }"
            />
          </UFormField>

          <UFormField
            :label="t('database.queryBuilder.aggregates')"
            :description="t('database.queryBuilder.aggregatesDescription')"
          >
            <div class="space-y-2">
              <div
                v-for="(row, index) in aggregateRows"
                :key="index"
                class="flex items-center gap-2 max-md:flex-wrap"
              >
                <!-- A phone: column + function + remove on one line, the
                alias below at full width. -->
                <USelectMenu
                  v-model="row.column"
                  :items="columns.map(c => c.name)"
                  class="w-40 max-md:min-w-0 max-md:flex-1"
                />
                <USelect
                  v-model="row.fn"
                  :items="aggregateFunctionsFor(columns.find(c => c.name === row.column)?.dataType).map(fn => ({ label: t(`database.queryBuilder.aggregateFunctions.${AGGREGATE_LABEL_KEYS[fn]}`), value: fn }))"
                  class="w-36 max-md:min-w-0 max-md:flex-1"
                />
                <UInput
                  v-model="row.alias"
                  :aria-label="t('database.queryBuilder.alias')"
                  class="flex-1 max-md:order-last max-md:basis-full"
                />
                <UButton
                  :aria-label="t('common.remove')"
                  icon="i-lucide-x"
                  size="xs"
                  color="neutral"
                  variant="link"
                  @click="removeAggregateRow(index)"
                />
              </div>
              <UButton
                :label="t('database.queryBuilder.addAggregate')"
                icon="i-lucide-plus"
                size="xs"
                color="neutral"
                variant="outline"
                :disabled="columns.length === 0"
                @click="addAggregateRow"
              />
            </div>
          </UFormField>

          <UFormField :label="t('database.queryBuilder.orderBy')">
            <div class="space-y-2">
              <div
                v-for="(row, index) in orderByRows"
                :key="index"
                class="flex items-center gap-2"
              >
                <USelectMenu
                  v-model="row.column"
                  :items="columns.map(c => c.name)"
                  class="w-48 max-md:min-w-0 max-md:flex-1"
                />
                <USelect
                  v-model="row.direction"
                  :items="[{ label: t('database.queryBuilder.ascending'), value: 'asc' }, { label: t('database.queryBuilder.descending'), value: 'desc' }]"
                  class="w-40 max-md:min-w-0 max-md:flex-1"
                />
                <UButton
                  :aria-label="t('common.remove')"
                  icon="i-lucide-x"
                  size="xs"
                  color="neutral"
                  variant="link"
                  @click="removeOrderByRow(index)"
                />
              </div>
              <UButton
                :label="t('database.queryBuilder.addOrderBy')"
                icon="i-lucide-plus"
                size="xs"
                color="neutral"
                variant="outline"
                :disabled="columns.length === 0"
                @click="addOrderByRow"
              />
            </div>
          </UFormField>

          <div class="flex items-end gap-3">
            <UFormField :label="t('database.queryBuilder.limit')">
              <UInputNumber
                v-model="limit"
                :min="1"
                class="w-48"
              />
            </UFormField>
            <UFormField :label="t('database.queryBuilder.offset')">
              <UInputNumber
                v-model="offset"
                :min="0"
                class="w-40"
              />
            </UFormField>
          </div>
          <UFormField
            :label="t('database.queryBuilder.count')"
            :description="t('database.queryBuilder.countDescription')"
          >
            <UCheckbox
              v-model="count"
              :label="t('database.queryBuilder.includeCount')"
            />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            :label="t('common.cancel')"
            @click="isBuildOpen = false"
          />
          <UButton
            :label="t('common.apply')"
            @click="applyBuild"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
