<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { Resource } from '~/types/resource'
import type { SqlExecuteResult } from '~/types/sql-console'
import type {
  ColumnBody,
  EditOperationBody,
  IndexDefinition,
  IndexMethod,
  RelationDetail,
  TableEditPlan
} from '~/types/schema'

const BASE_TYPES = [
  'uuid', 'text', 'varchar', 'char', 'integer', 'bigint', 'smallint',
  'numeric', 'boolean', 'timestamptz', 'timestamp', 'date', 'jsonb', 'text[]'
]
const LENGTH_TYPES = new Set(['varchar', 'char', 'character', 'character varying'])
const PRECISION_TYPES = new Set(['numeric', 'decimal'])
const INDEX_METHODS: IndexMethod[] = ['btree', 'hash', 'gist', 'gin', 'spgist', 'brin']

// A column's dataType is one string in Postgres ("numeric(12,2)"), but
// editing precision/scale as their own grid cells needs them apart -
// composed back into that one string only when actually building a request.
function composeDataType(base: string, length?: string, precision?: string, scale?: string): string {
  if (LENGTH_TYPES.has(base) && length) return `${base}(${length})`
  if (PRECISION_TYPES.has(base)) {
    if (precision && scale) return `${base}(${precision},${scale})`
    if (precision) return `${base}(${precision})`
  }
  return base
}

/**
 * Edit Table: the structured ALTER TABLE editor (PostgreSQL has no CREATE
 * OR REPLACE TABLE, so this is a table's real editor). Seeds the grid from
 * the table's current state and diffs the draft against it into a batch of
 * ALTER statements, shown as DDL for confirmation before Save. Creating a
 * table is NewTableModal's job.
 */
const props = defineProps<{ resource?: Resource | null }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [] }>()

const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const apiError = useApiErrorMessage()

// The shared table list (useResourcesList's convention) - the same one
// the page behind this drawer and the other table modals read.
const { tables: allTables } = useCatalogTablesList()

const activeTab = ref<'columns' | 'indexes' | 'data'>('columns')
const loading = ref(false)
const loadError = ref<string | null>(null)

const tableName = ref('')
const schema = ref('public')
const description = ref('')
const originalDescription = ref<string | null>(null)

interface DraftColumn {
  key: number
  /** null = new column, not yet created. */
  originalName: string | null
  name: string
  typeBase: string
  typeLength?: string
  typePrecision?: string
  typeScale?: string
  originalDataType: string | null
  nullable: boolean
  originalNullable: boolean | null
  default?: string
  originalDefault: string | null
  primaryKey: boolean
  originalPrimaryKey: boolean
  unique: boolean
  originalUnique: boolean
  uniqueConstraintName?: string
  check?: string
  originalCheck: string | null
  checkConstraintName?: string
  foreignKey?: ColumnBody['foreignKey']
  originalForeignKey?: ColumnBody['foreignKey']
  originalFkName?: string
  fkValid: boolean
  toDelete: boolean
}
let nextKey = 1
function blankColumn(): DraftColumn {
  return {
    key: nextKey++,
    originalName: null,
    name: '',
    typeBase: 'text',
    originalDataType: null,
    nullable: true,
    originalNullable: null,
    originalDefault: null,
    primaryKey: false,
    originalPrimaryKey: false,
    unique: false,
    originalUnique: false,
    originalCheck: null,
    fkValid: true,
    toDelete: false
  }
}
const columns = ref<DraftColumn[]>([])
const COLUMN_TABLE_COLUMNS = computed<TableColumn<DraftColumn>[]>(() => [
  { id: 'name', header: t('common.name'), meta: { class: { td: 'min-w-32' } } },
  { id: 'type', header: t('common.type'), meta: { class: { td: 'min-w-32' } } },
  { id: 'length', header: t('database.tableDrawer.lengthPrecision'), meta: { class: { td: 'w-24' } } },
  { id: 'scale', header: t('database.tableDrawer.scale'), meta: { class: { td: 'w-20' } } },
  { id: 'notNull', header: t('database.tableDrawer.notNull'), meta: { class: { th: 'text-center whitespace-nowrap' } } },
  { id: 'primaryKey', header: 'PK', meta: { class: { th: 'text-center' } } },
  { id: 'unique', header: t('database.tableDrawer.unique'), meta: { class: { th: 'text-center' } } },
  { id: 'check', header: t('database.tableDrawer.check'), meta: { class: { td: 'min-w-40' } } },
  { id: 'foreignKey', header: t('database.tableDrawer.foreignKey'), meta: { class: { td: 'min-w-40' } } },
  { id: 'default', header: t('database.tableDrawer.default'), meta: { class: { td: 'min-w-28' } } },
  { id: 'remove', header: '', meta: { class: { th: 'w-8' } } }
])

/** A grid row's controls are named after the column they edit - its original name, so a rename in progress doesn't rename them. */
function columnLabel(col: DraftColumn): string {
  return col.originalName ?? t('database.tableDrawer.newColumn')
}

function addColumn() {
  columns.value.push(blankColumn())
}
function removeColumn(col: DraftColumn) {
  // Never existed server-side (a column just added in this draft) - just
  // drop it. Otherwise it's a soft "pending drop", reversible until Save,
  // mirroring the pattern for indexes below.
  if (col.originalName === null) {
    columns.value = columns.value.filter(c => c.key !== col.key)
  } else {
    col.toDelete = !col.toDelete
  }
}

interface DraftIndex {
  key: number
  originalName: string | null
  name?: string
  columns: string[]
  /** Per-column sort direction, keyed by column name - a plain name sorts ASC (Postgres's own default). */
  directions: Record<string, 'asc' | 'desc'>
  method: IndexMethod
  unique: boolean
  where?: string
  concurrently: boolean
  toDelete: boolean
}
const indexes = ref<DraftIndex[]>([])
const INDEX_TABLE_COLUMNS = computed<TableColumn<DraftIndex>[]>(() => [
  { id: 'name', header: t('common.name'), meta: { class: { td: 'min-w-32' } } },
  { id: 'columns', header: t('database.tableDrawer.columns'), meta: { class: { td: 'min-w-56' } } },
  { id: 'order', header: t('database.tableDrawer.order'), meta: { class: { td: 'min-w-40' } } },
  { id: 'method', header: t('database.tableDrawer.method'), meta: { class: { td: 'min-w-32' } } },
  { id: 'unique', header: t('database.tableDrawer.unique'), meta: { class: { th: 'text-center' } } },
  { id: 'where', header: t('database.tableDrawer.wherePartial'), meta: { class: { td: 'min-w-40' } } },
  { id: 'concurrently', header: t('database.tableDrawer.concurrently'), meta: { class: { th: 'text-center' } } },
  { id: 'remove', header: '', meta: { class: { th: 'w-8' } } }
])
let nextIndexKey = 1
function blankIndex(): DraftIndex {
  return { key: nextIndexKey++, originalName: null, columns: [], directions: {}, method: 'btree', unique: false, concurrently: false, toDelete: false }
}
function addIndex() {
  indexes.value.push(blankIndex())
}
function removeIndex(idx: DraftIndex) {
  if (idx.originalName === null) {
    indexes.value = indexes.value.filter(i => i.key !== idx.key)
  } else {
    idx.toDelete = !idx.toDelete
  }
}

// Whether TotalBase's PostgreSQL role owns the table
// (Administration.md §3.15). When it doesn't, the drawer still
// shows the structure but offers no change - PostgreSQL would refuse it.
const ownership = ref<Pick<RelationDetail, 'owner' | 'canAlter'> | null>(null)
const notOwned = computed(() => ownership.value?.canAlter === false)

// Only the latest load may fill the draft: a reopen on another table while
// the previous load is still in flight must not seed the grid twice.
const latestLoad = useLatest()

async function loadEditDraft() {
  if (!props.resource) return
  const load = latestLoad.next()
  nextKey = 1
  nextIndexKey = 1
  loading.value = true
  loadError.value = null
  formError.value = null
  ownership.value = null
  try {
    const [{ data: detail }, { data: indexList }] = await Promise.all([
      api.get<RelationDetail>(`/catalog/table/${props.resource.id}`),
      api.get<IndexDefinition[]>(`/catalog/table/${props.resource.id}/indexes`)
    ])
    if (!load.isCurrent()) return

    ownership.value = { owner: detail.owner, canAlter: detail.canAlter }
    tableName.value = props.resource.name
    schema.value = props.resource.schema
    description.value = props.resource.description ?? ''
    originalDescription.value = props.resource.description

    columns.value = detail.columns.map((c) => {
      // The catalog gives the type's parts apart (typeName/typeLength/
      // typePrecision/typeScale) - the grid's separate cells edit them. A
      // domain column's are its base type's: the grid shows and keeps the domain.
      const base = c.domain ?? c.typeName ?? c.dataType
      const uniqueGroup = detail.uniqueConstraints.findIndex((g, i) => g.length === 1 && g[0] === c.name && detail.uniqueConstraintNames[i])
      // The column's own CHECK: the one naming this column alone (pg_constraint.conkey).
      const check = detail.checkConstraints.find(cc => cc.columns.length === 1 && cc.columns[0] === c.name)
      const relation = detail.relations.find(r => r.sourceColumn === c.name)
      return {
        key: nextKey++,
        originalName: c.name,
        name: c.name,
        typeBase: base,
        typeLength: LENGTH_TYPES.has(base) && c.typeLength != null ? String(c.typeLength) : undefined,
        typePrecision: PRECISION_TYPES.has(base) && c.typePrecision != null ? String(c.typePrecision) : undefined,
        typeScale: PRECISION_TYPES.has(base) && c.typeScale != null ? String(c.typeScale) : undefined,
        originalDataType: c.domain ?? c.dataType,
        nullable: c.nullable,
        originalNullable: c.nullable,
        default: c.defaultExpression ?? undefined,
        originalDefault: c.defaultExpression,
        primaryKey: detail.primaryKey.includes(c.name),
        originalPrimaryKey: detail.primaryKey.includes(c.name),
        unique: uniqueGroup !== -1,
        originalUnique: uniqueGroup !== -1,
        uniqueConstraintName: uniqueGroup !== -1 ? detail.uniqueConstraintNames[uniqueGroup] : undefined,
        check: check?.expression,
        originalCheck: check?.expression ?? null,
        checkConstraintName: check?.name,
        foreignKey: relation
          ? { targetSchema: relation.targetSchema, targetTable: relation.targetTable, targetColumn: relation.targetColumn }
          : undefined,
        originalForeignKey: relation
          ? { targetSchema: relation.targetSchema, targetTable: relation.targetTable, targetColumn: relation.targetColumn }
          : undefined,
        originalFkName: relation?.name,
        fkValid: true,
        toDelete: false
      }
    })

    indexes.value = indexList
      // Constraint-backed indexes (PK/UNIQUE) are managed through the
      // columns grid, not here - listing them again would invite
      // conflicting drop_constraint/drop_index operations on the same object.
      .filter(i => !i.isPrimary)
      // The catalog's structured index: its keys with their direction (so a
      // DESC key round-trips instead of silently reverting to ASC), its
      // method and its predicate - nothing parsed out of pg_get_indexdef().
      .map(i => ({
        key: nextIndexKey++,
        originalName: i.name,
        name: i.name,
        columns: i.keys.map(k => k.name),
        directions: Object.fromEntries(i.keys.filter(k => k.direction === 'desc').map(k => [k.name, 'desc' as const])),
        method: i.method as IndexMethod,
        unique: i.isUnique,
        where: i.predicate ?? undefined,
        concurrently: false,
        toDelete: false
      }))
  } catch (err) {
    if (!load.isCurrent()) return
    loadError.value = apiError(err, t('database.tableDrawer.loadError'))
  } finally {
    if (load.isCurrent()) loading.value = false
  }
}

// Keyed by the resource's id, not the object: the list behind this drawer
// refreshing (and handing out a new object for the same table) must not
// reload the draft under an edit in progress.
watch(() => [open.value, props.resource?.id] as const, ([isOpen]) => {
  if (isOpen) loadEditDraft()
}, { immediate: true })

// --- Foreign key modal - one at a time, targeting whichever column's
// pencil icon was clicked (one shared editor keyed by row).
const fkModalTarget = ref<DraftColumn | null>(null)
const isFkModalOpen = computed({
  get: () => fkModalTarget.value !== null,
  set: (v: boolean) => { if (!v) fkModalTarget.value = null }
})
function openFkModal(col: DraftColumn) {
  fkModalTarget.value = col
}

const canSave = computed(() =>
  tableName.value.trim() !== ''
  && columns.value.some(c => !c.toDelete)
  && columns.value.every(c => c.toDelete || (c.name.trim() && c.typeBase.trim() && c.fkValid))
  && indexes.value.every(i => i.toDelete || i.columns.length > 0)
)

// Diffs the draft against the original snapshot into the operations batch.
function buildOperations(): EditOperationBody[] {
  if (!props.resource) return []
  const ops: EditOperationBody[] = []

  for (const c of columns.value) {
    if (c.originalName === null) {
      if (c.toDelete) continue // added then removed in the same draft - no-op
      ops.push({
        kind: 'add_column',
        column: {
          name: c.name,
          dataType: composeDataType(c.typeBase, c.typeLength, c.typePrecision, c.typeScale),
          nullable: c.nullable,
          default: c.default,
          primaryKey: c.primaryKey,
          unique: c.unique || undefined,
          check: c.check,
          foreignKey: c.foreignKey
        }
      })
      continue
    }

    if (c.toDelete) {
      ops.push({ kind: 'drop_column', column: c.originalName, cascade: true })
      continue
    }

    const newDataType = composeDataType(c.typeBase, c.typeLength, c.typePrecision, c.typeScale)
    const patch: { rename?: string, dataType?: string, nullable?: boolean, default?: string | null } = {}
    if (c.name !== c.originalName) patch.rename = c.name
    if (newDataType !== c.originalDataType) patch.dataType = newDataType
    if (c.nullable !== c.originalNullable) patch.nullable = c.nullable
    if ((c.default ?? null) !== c.originalDefault) patch.default = c.default ?? null
    if (Object.keys(patch).length > 0) ops.push({ kind: 'alter_column', column: c.originalName, patch })

    // Unique: a single-column UNIQUE constraint, added or dropped.
    if (c.unique && !c.originalUnique) {
      ops.push({ kind: 'add_unique', columns: [c.name] })
    } else if (!c.unique && c.originalUnique && c.uniqueConstraintName) {
      ops.push({ kind: 'drop_constraint', name: c.uniqueConstraintName })
    }

    // Check: compared by presence/text, added or dropped+re-added.
    if (c.check !== c.originalCheck) {
      if (c.checkConstraintName) ops.push({ kind: 'drop_constraint', name: c.checkConstraintName })
      if (c.check) ops.push({ kind: 'add_check', name: `${tableName.value}_${c.name}_check`, expression: c.check })
    }

    // Foreign key: replaced wholesale (drop the old constraint, add the new one) when changed.
    const fkChanged = JSON.stringify(c.foreignKey ?? null) !== JSON.stringify(c.originalForeignKey ?? null)
    if (c.foreignKey && !c.originalFkName) {
      ops.push({ kind: 'add_foreign_key', column: c.name, targetSchema: c.foreignKey.targetSchema, targetTable: c.foreignKey.targetTable, targetColumn: c.foreignKey.targetColumn, onDelete: c.foreignKey.onDelete, onUpdate: c.foreignKey.onUpdate })
    } else if (!c.foreignKey && c.originalFkName) {
      ops.push({ kind: 'drop_constraint', name: c.originalFkName })
    } else if (c.foreignKey && c.originalFkName && fkChanged) {
      ops.push({ kind: 'drop_constraint', name: c.originalFkName })
      ops.push({ kind: 'add_foreign_key', column: c.name, targetSchema: c.foreignKey.targetSchema, targetTable: c.foreignKey.targetTable, targetColumn: c.foreignKey.targetColumn, onDelete: c.foreignKey.onDelete, onUpdate: c.foreignKey.onUpdate })
    }
  }

  // Primary key: one set_primary_key op if the PK column set actually changed.
  const newPk = columns.value.filter(c => !c.toDelete && c.primaryKey).map(c => c.name).sort()
  const oldPk = columns.value.filter(c => c.originalPrimaryKey).map(c => c.originalName).sort()
  if (JSON.stringify(newPk) !== JSON.stringify(oldPk) && newPk.length > 0) {
    ops.push({ kind: 'set_primary_key', columns: newPk })
  }

  for (const i of indexes.value) {
    if (i.originalName === null) {
      if (i.toDelete) continue
      ops.push({
        kind: 'create_index',
        name: i.name,
        columns: i.columns.map(name => (i.directions[name] === 'desc' ? { name, direction: 'desc' as const } : { name })),
        method: i.method,
        unique: i.unique || undefined,
        where: i.where,
        concurrently: i.concurrently || undefined
      })
    } else if (i.toDelete) {
      ops.push({ kind: 'drop_index', name: i.originalName, concurrently: i.concurrently || undefined })
    }
  }

  // Last: every operation above still addresses the table by its current
  // name (POST .../edit runs them in order, in one transaction).
  if (tableName.value !== props.resource.name) {
    ops.push({ kind: 'rename_table', newName: tableName.value })
  }

  return ops
}

// --- DDL confirmation - the same body, sent once to the route's preview
// (server returns the SQL without executing it) and once for real, so the
// preview can never show something different from what actually runs.
// Two SQL blocks: transactional vs CONCURRENTLY, which PostgreSQL forbids
// mixing into one transaction.
const isConfirmOpen = ref(false)
const plan = ref<TableEditPlan | null>(null)
const previewing = ref(false)
const saving = ref(false)
const formError = ref<string | null>(null)

const confirmBlocks = computed(() => {
  const blocks: { title: string, sql: string }[] = []
  if (plan.value?.transactional.length) blocks.push({ title: t('database.tableDrawer.blockTransaction'), sql: `${plan.value.transactional.join(';\n\n')};` })
  if (plan.value?.concurrent.length) blocks.push({ title: t('database.tableDrawer.blockConcurrent'), sql: `${plan.value.concurrent.join(';\n\n')};` })
  return blocks
})

async function openConfirm() {
  formError.value = null
  previewing.value = true
  try {
    if (!props.resource) return
    const operations = buildOperations()
    const descriptionChanged = description.value.trim() !== (originalDescription.value ?? '')
    if (operations.length === 0 && !descriptionChanged) {
      toast.add({ title: t('database.tableDrawer.nothingToSave'), color: 'neutral' })
      return
    }
    const { data } = await api.post<TableEditPlan>(
      `/schema/${props.resource.schema}/tables/${props.resource.name}/edit/preview`,
      { data: { operations } }
    )
    plan.value = data
    isConfirmOpen.value = true
  } catch (err) {
    formError.value = apiError(err, t('database.tableDrawer.previewError'))
  } finally {
    previewing.value = false
  }
}

// AppDrawer owns `expanded` (and collapses it back on every open) now -
// this only resets the form-specific state that's still this
// component's own.
watch(open, (isOpen) => {
  if (!isOpen) {
    activeTab.value = 'columns'
    result.value = null
    dataOffset.value = 0
    formError.value = null
  }
})

async function confirmSave() {
  saving.value = true
  formError.value = null
  try {
    if (!props.resource) return
    const operations = buildOperations()
    if (operations.length > 0) {
      await api.post(`/schema/${props.resource.schema}/tables/${props.resource.name}/edit`, { data: { operations } })
    }
    if (description.value.trim() !== (originalDescription.value ?? '')) {
      await api.patch(`/resources/${props.resource.id}`, { data: { description: description.value.trim() || null } })
    }
    toast.add({ title: t('database.tableDrawer.saved'), color: 'success' })

    isConfirmOpen.value = false
    open.value = false
    emit('saved')
  } catch (err) {
    formError.value = apiError(err, t('database.tableDrawer.saveError'))
    isConfirmOpen.value = false
  } finally {
    saving.value = false
  }
}

// --- Data tab: read-only preview, deliberately not a
// data editor. Always queries the table's ORIGINAL name/schema, since a
// pending rename hasn't run yet. See AGENTS.md: "TotalBase doesn't
// become a pgAdmin/data editor."
const DATA_PAGE_SIZE = 25
const dataOffset = ref(0)
const dataLoading = ref(false)
const result = ref<SqlExecuteResult | null>(null)
const dataError = ref<string | null>(null)
const dataHasMore = ref(false)

async function loadData() {
  if (!props.resource) return
  dataLoading.value = true
  dataError.value = null
  try {
    // Read by the server (catalog preview: by OID, READ ONLY) - the admin
    // never builds SQL, and a preview doesn't land in SQL Console history.
    const { data } = await api.get<{ columns: SqlExecuteResult['columns'], rows: SqlExecuteResult['rows'], hasMore: boolean, durationMs: number }>(
      `/catalog/table/${props.resource.id}/rows`,
      { limit: DATA_PAGE_SIZE, offset: dataOffset.value }
    )
    result.value = { status: 'EXECUTED', rows: data.rows, rowCount: data.rows.length, columns: data.columns, notices: [], durationMs: data.durationMs }
    dataHasMore.value = data.hasMore
  } catch (err) {
    result.value = null
    dataError.value = apiError(err, t('database.tableDrawer.dataError'))
  } finally {
    dataLoading.value = false
  }
}

watch(activeTab, (tab) => {
  if (tab === 'data' && !result.value && !dataLoading.value) loadData()
})

function nextPage() {
  dataOffset.value += DATA_PAGE_SIZE
  loadData()
}
function prevPage() {
  dataOffset.value = Math.max(0, dataOffset.value - DATA_PAGE_SIZE)
  loadData()
}
</script>

<template>
  <AppDrawer
    v-model:open="open"
    :title="resource ? t('database.tableDrawer.editTitle', { name: `${resource.schema}.${resource.name}` }) : t('database.tableDrawer.editTitleFallback')"
    :description="t('database.tableDrawer.editDescription')"
  >
    <div
      v-if="resource"
      class="flex-1 min-h-0 overflow-y-auto flex flex-col gap-4"
    >
      <UAlert
        v-if="formError"
        color="error"
        variant="subtle"
        :title="formError"
      />
      <UAlert
        v-if="loadError"
        color="error"
        variant="subtle"
        :title="loadError"
      />
      <NotOwnedNote
        v-if="notOwned"
        kind="table"
        :owner="ownership!.owner"
      />

      <div class="flex flex-col sm:flex-row gap-3">
        <UFormField
          :label="t('database.tableDrawer.tableName')"
          :description="t('database.tableDrawer.tableNameHelp')"
          class="w-full sm:w-[250px] shrink-0"
        >
          <UInput
            v-model="tableName"
            class="w-full"
          />
        </UFormField>
        <UFormField
          :label="t('database.tableDrawer.schema')"
          class="w-full sm:w-[250px] shrink-0"
        >
          <UInput
            :model-value="schema"
            disabled
            class="w-full"
          />
        </UFormField>
        <UFormField
          :label="t('database.tableDrawer.descriptionLabel')"
          :description="t('database.tableDrawer.descriptionHelp')"
          class="flex-1"
        >
          <UInput
            v-model="description"
            class="w-full"
          />
        </UFormField>
      </div>

      <UTabs
        v-model="activeTab"
        variant="link"
        :items="[
          { label: t('database.tableDrawer.tabColumns'), value: 'columns' },
          { label: t('database.tableDrawer.tabIndexes'), value: 'indexes' },
          { label: t('database.tableDrawer.tabData'), value: 'data' }
        ]"
        :content="false"
        size="sm"
        class="shrink-0 w-72"
      />

      <UEmpty
        v-if="loading"
        loading
        variant="naked"
        size="sm"
      />

      <template v-else>
        <!-- Columns -->
        <div
          v-show="activeTab === 'columns'"
          class="flex flex-col gap-3"
        >
          <div class="flex items-center justify-end">
            <UButton
              icon="i-lucide-plus"
              :label="t('database.tableDrawer.addColumn')"
              size="sm"
              color="neutral"
              variant="outline"
              :disabled="notOwned"
              @click="addColumn"
            />
          </div>

          <UTable
            sticky
            :meta="{ class: { tr: (row: { original: DraftColumn }) => (row.original.toDelete ? 'opacity-40' : '') } }"
            :data="columns"
            :columns="COLUMN_TABLE_COLUMNS"
          >
            <template #name-cell="{ row: { original: col } }">
              <UInput
                v-model="col.name"
                :aria-label="t('database.tableDrawer.ariaName', { column: columnLabel(col) })"
                size="sm"
                :disabled="col.toDelete"
              />
            </template>
            <template #type-cell="{ row: { original: col } }">
              <UInputMenu
                v-model="col.typeBase"
                :aria-label="t('database.tableDrawer.ariaType', { column: columnLabel(col) })"
                mode="autocomplete"
                :items="BASE_TYPES"
                size="sm"
                :disabled="col.toDelete"
              />
            </template>
            <template #length-cell="{ row: { original: col } }">
              <UInput
                v-if="LENGTH_TYPES.has(col.typeBase) || PRECISION_TYPES.has(col.typeBase)"
                v-model="col.typeLength"
                :aria-label="t('database.tableDrawer.ariaLength', { column: columnLabel(col) })"
                size="sm"
                :disabled="col.toDelete"
              />
            </template>
            <template #scale-cell="{ row: { original: col } }">
              <UInput
                v-if="PRECISION_TYPES.has(col.typeBase)"
                v-model="col.typeScale"
                :aria-label="t('database.tableDrawer.ariaScale', { column: columnLabel(col) })"
                size="sm"
                :disabled="col.toDelete"
              />
            </template>
            <template #notNull-cell="{ row: { original: col } }">
              <div class="flex justify-center">
                <UCheckbox
                  :model-value="col.nullable === false"
                  :aria-label="t('database.tableDrawer.ariaNotNull', { column: columnLabel(col) })"
                  :disabled="col.toDelete"
                  @update:model-value="(v: boolean | 'indeterminate') => { col.nullable = v !== true }"
                />
              </div>
            </template>
            <template #primaryKey-cell="{ row: { original: col } }">
              <div class="flex justify-center">
                <UCheckbox
                  :model-value="col.primaryKey"
                  :aria-label="t('database.tableDrawer.ariaPrimaryKey', { column: columnLabel(col) })"
                  :disabled="col.toDelete"
                  @update:model-value="(v: boolean | 'indeterminate') => { col.primaryKey = v === true }"
                />
              </div>
            </template>
            <template #unique-cell="{ row: { original: col } }">
              <div class="flex justify-center">
                <UCheckbox
                  :model-value="col.unique"
                  :aria-label="t('database.tableDrawer.ariaUnique', { column: columnLabel(col) })"
                  :disabled="col.toDelete"
                  @update:model-value="(v: boolean | 'indeterminate') => { col.unique = v === true }"
                />
              </div>
            </template>
            <template #check-cell="{ row: { original: col } }">
              <div class="flex items-center gap-1">
                <UInput
                  :model-value="col.check ?? ''"
                  :aria-label="t('database.tableDrawer.ariaCheck', { column: columnLabel(col) })"
                  size="sm"
                  disabled
                  class="flex-1"
                />
                <UPopover>
                  <UButton
                    icon="i-lucide-pencil"
                    :aria-label="t('database.tableDrawer.ariaEditCheck', { column: columnLabel(col) })"
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    :disabled="col.toDelete"
                  />
                  <template #content>
                    <div class="flex flex-col gap-2 p-3 w-64">
                      <UFormField
                        :label="t('database.tableDrawer.check')"
                        :description="t('database.tableDrawer.checkHelp', { example: 'price >= 0' })"
                      >
                        <UInput
                          v-model="col.check"
                          class="w-full font-mono text-xs"
                          autofocus
                        />
                      </UFormField>
                      <UButton
                        v-if="col.check"
                        :label="t('common.clear')"
                        size="xs"
                        color="error"
                        variant="ghost"
                        class="self-end"
                        @click="col.check = undefined"
                      />
                    </div>
                  </template>
                </UPopover>
              </div>
            </template>
            <template #foreignKey-cell="{ row: { original: col } }">
              <div class="flex items-center gap-1">
                <UInput
                  :model-value="col.foreignKey ? `${col.foreignKey.targetTable}.${col.foreignKey.targetColumn}` : ''"
                  :aria-label="t('database.tableDrawer.ariaForeignKey', { column: columnLabel(col) })"
                  size="sm"
                  disabled
                  class="flex-1"
                />
                <UTooltip :text="!col.fkValid ? t('database.tableDrawer.invalidFk') : t('database.tableDrawer.foreignKey')">
                  <UButton
                    icon="i-lucide-pencil"
                    :aria-label="t('database.tableDrawer.ariaEditForeignKey', { column: columnLabel(col) })"
                    size="xs"
                    :color="!col.fkValid ? 'warning' : 'neutral'"
                    variant="ghost"
                    :disabled="col.toDelete"
                    @click="openFkModal(col)"
                  />
                </UTooltip>
              </div>
            </template>
            <template #default-cell="{ row: { original: col } }">
              <UInput
                v-model="col.default"
                :aria-label="t('database.tableDrawer.ariaDefault', { column: columnLabel(col) })"
                size="sm"
                :disabled="col.toDelete"
              />
            </template>
            <template #remove-cell="{ row: { original: col } }">
              <UTooltip :text="col.originalName !== null ? (col.toDelete ? t('database.tableDrawer.undoRemove') : t('common.remove')) : t('common.remove')">
                <UButton
                  :icon="col.toDelete ? 'i-lucide-rotate-ccw' : 'i-lucide-trash-2'"
                  :aria-label="col.toDelete ? t('database.tableDrawer.ariaUndoRemove', { column: columnLabel(col) }) : t('database.tableDrawer.ariaRemove', { column: columnLabel(col) })"
                  size="xs"
                  :color="col.toDelete ? 'neutral' : 'error'"
                  variant="ghost"
                  @click="removeColumn(col)"
                />
              </UTooltip>
            </template>
          </UTable>
          <p class="text-xs text-muted">
            {{ t('database.tableDrawer.defaultHelp', { example1: 'now()', example2: '0' }) }}
          </p>
        </div>

        <!-- Indexes -->
        <div
          v-show="activeTab === 'indexes'"
          class="flex flex-col gap-3"
        >
          <div class="flex items-center justify-end">
            <UButton
              icon="i-lucide-plus"
              :label="t('database.tableDrawer.addIndex')"
              size="sm"
              color="neutral"
              variant="outline"
              :disabled="notOwned"
              @click="addIndex"
            />
          </div>

          <UTable
            sticky
            :meta="{ class: { tr: (row: { original: DraftIndex }) => (row.original.toDelete ? 'opacity-40' : '') } }"
            :data="indexes"
            :columns="INDEX_TABLE_COLUMNS"
          >
            <template #name-cell="{ row: { original: idx } }">
              <UInput
                v-model="idx.name"
                :aria-label="t('common.name')"
                size="sm"
                :disabled="idx.toDelete || idx.originalName !== null"
              />
            </template>
            <template #columns-cell="{ row: { original: idx } }">
              <USelectMenu
                v-model="idx.columns"
                :aria-label="t('database.tableDrawer.columns')"
                multiple
                :items="columns.filter(c => !c.toDelete).map(c => c.name)"
                size="sm"
                class="w-full"
                :disabled="idx.toDelete || idx.originalName !== null"
              />
            </template>
            <template #order-cell="{ row: { original: idx } }">
              <div
                v-if="idx.columns.length > 0"
                class="flex flex-col gap-1"
              >
                <div
                  v-for="col in idx.columns"
                  :key="col"
                  class="flex items-center gap-2"
                >
                  <span class="text-xs text-muted truncate flex-1">{{ col }}</span>
                  <USelect
                    :aria-label="`${col} - ${t('common.direction')}`"
                    :model-value="idx.directions[col] ?? 'asc'"
                    :items="['asc', 'desc']"
                    size="sm"
                    class="w-24"
                    :disabled="idx.toDelete"
                    @update:model-value="(v: string) => { idx.directions[col] = v as 'asc' | 'desc' }"
                  />
                </div>
              </div>
              <span
                v-else
                class="text-xs text-muted"
              >—</span>
            </template>
            <template #method-cell="{ row: { original: idx } }">
              <USelect
                v-model="idx.method"
                :aria-label="t('database.tableDrawer.method')"
                :items="INDEX_METHODS"
                size="sm"
                class="w-full"
                :disabled="idx.toDelete || idx.originalName !== null"
              />
            </template>
            <template #unique-cell="{ row: { original: idx } }">
              <div class="flex justify-center">
                <UCheckbox
                  :model-value="idx.unique"
                  :disabled="idx.toDelete || idx.originalName !== null"
                  @update:model-value="(v: boolean | 'indeterminate') => { idx.unique = v === true }"
                />
              </div>
            </template>
            <template #where-cell="{ row: { original: idx } }">
              <UInput
                v-model="idx.where"
                :aria-label="t('database.tableDrawer.wherePartial')"
                size="sm"
                class="font-mono text-xs"
                :disabled="idx.toDelete || idx.originalName !== null"
              />
            </template>
            <template #concurrently-cell="{ row: { original: idx } }">
              <UTooltip :text="t('database.tableDrawer.concurrentlyHelp')">
                <div class="flex justify-center">
                  <UCheckbox
                    :model-value="idx.concurrently"
                    @update:model-value="(v: boolean | 'indeterminate') => { idx.concurrently = v === true }"
                  />
                </div>
              </UTooltip>
            </template>
            <template #empty>
              <UEmpty
                variant="naked"
                size="sm"
                icon="i-lucide-list-ordered"
                :title="t('database.tableDrawer.noIndexes')"
              />
            </template>
            <template #remove-cell="{ row: { original: idx } }">
              <UTooltip :text="idx.toDelete ? t('database.tableDrawer.undoRemove') : t('common.remove')">
                <UButton
                  :aria-label="idx.toDelete ? t('database.tableDrawer.undoRemove') : t('common.remove')"
                  :icon="idx.toDelete ? 'i-lucide-rotate-ccw' : 'i-lucide-trash-2'"
                  size="xs"
                  :color="idx.toDelete ? 'neutral' : 'error'"
                  variant="ghost"
                  @click="removeIndex(idx)"
                />
              </UTooltip>
            </template>
          </UTable>
          <p class="text-xs text-muted">
            {{ t('database.tableDrawer.indexesHelp', { example: 'active = true' }) }}
          </p>
        </div>

        <!-- Data: read-only preview, deliberately not a data editor. See
            AGENTS.md: "TotalBase doesn't become a pgAdmin/data editor." -->
        <div
          v-if="activeTab === 'data'"
          class="flex flex-col flex-1 min-h-0 gap-2"
        >
          <UAlert
            color="neutral"
            variant="subtle"
            icon="i-lucide-eye"
            :title="t('database.tableDrawer.readOnlyTitle')"
            :description="t('database.tableDrawer.readOnlyDescription')"
          />

          <div class="flex-1 min-h-0 border border-default rounded-lg p-3">
            <SqlResultsPanel
              :result="result"
              :error="dataError"
              :executing="dataLoading"
            />
          </div>

          <div class="flex items-center justify-between shrink-0">
            <span class="text-xs text-muted">{{ t('database.tableDrawer.rowsRange', { from: dataOffset + 1, to: dataOffset + (result?.rows.length ?? 0) }) }}</span>
            <div class="flex items-center gap-2">
              <UButton
                :label="t('database.tableDrawer.previous')"
                size="sm"
                color="neutral"
                variant="outline"
                :disabled="dataOffset === 0 || dataLoading"
                @click="prevPage"
              />
              <UButton
                :label="t('common.next')"
                size="sm"
                color="neutral"
                variant="outline"
                :disabled="!dataHasMore || dataLoading"
                @click="nextPage"
              />
            </div>
          </div>
        </div>
      </template>
    </div>

    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton
          :label="t('common.cancel')"
          color="neutral"
          variant="ghost"
          @click="open = false"
        />
        <UButton
          :label="t('common.save')"
          :disabled="!canSave || loading || notOwned"
          :loading="previewing"
          @click="openConfirm"
        />
      </div>
    </template>
  </AppDrawer>

  <!-- DDL confirmation - the exact statement(s) about to run, generated
  server-side by the same code the real execution path uses, so the
  preview can never drift from what actually runs. -->
  <UModal
    v-model:open="isConfirmOpen"
    :title="t('database.tableDrawer.confirmEditTitle')"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <p class="text-sm text-muted">
          {{ t('database.tableDrawer.confirmIntro') }}
        </p>
        <div
          v-for="block in confirmBlocks"
          :key="block.title"
          class="flex flex-col gap-1"
        >
          <p class="text-xs font-medium text-highlighted">
            {{ block.title }}
          </p>
          <pre class="text-xs font-mono whitespace-pre-wrap bg-elevated rounded-md p-3 overflow-x-auto max-h-72 overflow-y-auto">{{ block.sql }}</pre>
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton
          :label="t('common.back')"
          color="neutral"
          variant="ghost"
          :disabled="saving"
          @click="isConfirmOpen = false"
        />
        <UButton
          :label="t('database.tableDrawer.confirmSave')"
          :loading="saving"
          @click="confirmSave"
        />
      </div>
    </template>
  </UModal>

  <!-- Foreign key - one modal, targeting whichever column's pencil was
  clicked. Several fields (schema/table/column/on delete/on update) plus
  validation feedback, so this is the "modal" side of AGENTS.md §25's
  popover/modal split - Check above is the "popover" side (one field). -->
  <UModal
    v-model:open="isFkModalOpen"
    :title="fkModalTarget ? t('database.tableDrawer.fkModalTitle', { column: fkModalTarget.name || t('database.tableDrawer.column') }) : t('database.tableDrawer.foreignKey')"
  >
    <template #body>
      <div
        v-if="fkModalTarget"
        class="flex flex-col gap-4"
      >
        <ForeignKeyFields
          v-model="fkModalTarget.foreignKey"
          v-model:valid="fkModalTarget.fkValid"
          :all-tables="(allTables ?? []).filter(table => !(table.name === resource?.name && table.schema === resource?.schema))"
        />
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton
          v-if="fkModalTarget?.foreignKey"
          :label="t('common.clear')"
          color="error"
          variant="ghost"
          @click="fkModalTarget.foreignKey = undefined; isFkModalOpen = false"
        />
        <UButton
          :label="t('common.done')"
          @click="isFkModalOpen = false"
        />
      </div>
    </template>
  </UModal>
</template>
