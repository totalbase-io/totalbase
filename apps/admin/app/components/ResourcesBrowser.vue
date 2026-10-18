<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { AuditLog } from '~/types/audit'
import type { CatalogRefreshResult, DataApiMethod, Resource } from '~/types/resource'
import type { SqlExecuteResult } from '~/types/sql-console'
import { APPLICABLE_METHODS } from '~/types/resource'
// Absolute dates/times in the user's zone and format (My account > Preferences).
const dates = useDateTimeFormat()

/**
 * Shared listing behind the single Database tree page (`database/index.vue`)
 * - one screen for every relation type, driven by the tree in the group's
 * own nav panel (`DatabaseTree.vue`) instead of a fixed per-page type.
 * `type`/`schema` are v-models rather than a locked `fixedType` prop: a tree
 * category-node click sets both to filter this list, a tree leaf click also
 * calls the exposed `openDetail()` to jump straight to that resource's
 * page.
 */
const type = defineModel<Resource['type']>('type', { required: true })
const schema = defineModel<string>('schema', { default: 'all' })

const api = useAdminApi()
const resourcesApi = useResourcesApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()

const COPY_KEY: Record<Resource['type'], string> = { TABLE: 'table', VIEW: 'view', FUNCTION: 'function' }
const copy = computed(() => {
  const key = COPY_KEY[type.value]
  return {
    title: t(`database.resourcesBrowser.copy.${key}.title`),
    description: t(`database.resourcesBrowser.copy.${key}.description`),
    newLabel: t(`database.resourcesBrowser.copy.${key}.newLabel`)
  }
})

// One drawer, two intents: "New resource" opens it blank (create); a View/
// Function row's "Edit" action opens the same drawer pre-filled with its
// current DDL as a CREATE OR REPLACE (Specification_Administration.md §4: "Create/edit
// Views and Functions through SQL Console" - there's no POST/PATCH schema
// endpoint that accepts full source). Tables don't get this action -
// PostgreSQL has no CREATE OR REPLACE TABLE, so TableDrawer's structured
// ALTER TABLE editor (add column, constraints, etc.) is the real editor
// for those.
const isSqlConsoleOpen = ref(false)
const sqlConsoleMode = ref<'create' | 'edit'>('create')
const sqlConsoleInitialSql = ref('')
const sqlConsoleEditingLabel = ref('')
const isCreateTableOpen = ref(false)
const isEditTableOpen = ref(false)
const editTableTarget = ref<Resource | null>(null)

function openNewResource() {
  sqlConsoleMode.value = 'create'
  isSqlConsoleOpen.value = true
}

// Specification_Administration.md: saving the minimal New
// Table wizard navigates straight to the new table's own detail page to
// keep adding columns there, rather than the wizard growing into the
// full page itself.
function onTableCreated(resource: { id: string | null, oid: number | null }) {
  refresh()
  if (resource.id !== null) navigateTo(`/resources/${resource.id}`)
}

// Tables get a choice between the visual Table creator and raw SQL;
// Views/Functions only ever go through SQL Console (no POST schema
// endpoint for those - see the comment above), so their toolbar button
// skips the dropdown entirely.
const NEW_RESOURCE_ITEMS = computed(() => [
  {
    label: t('database.resourcesBrowser.newTable'),
    description: t('database.resourcesBrowser.newTableDescription'),
    icon: 'i-lucide-table',
    onSelect: () => { isCreateTableOpen.value = true }
  },
  {
    label: t('database.resourcesBrowser.newCustom'),
    description: t('database.resourcesBrowser.newCustomDescription'),
    icon: 'i-lucide-terminal',
    onSelect: openNewResource
  }
])

async function openEditResource(resource: Resource) {
  try {
    // Both come back as a complete, runnable CREATE OR REPLACE statement.
    const { data } = await api.get<{ ddl: string }>(`/catalog/${resource.type === 'VIEW' ? 'view' : 'function'}/${resource.id}/ddl`)
    sqlConsoleMode.value = 'edit'
    sqlConsoleInitialSql.value = data.ddl
    sqlConsoleEditingLabel.value = `${resource.schema}.${resource.name}`
    isSqlConsoleOpen.value = true
  } catch (err) {
    notifyError(err, t('database.resourcesBrowser.loadDefinitionError'))
  }
}

const search = ref('')

// Query params per Specification_Admin_UI.md §11.1: ?schema=/?type=. "Exposed"/"Hidden" are filtered
// client-side (below) since exposure is now just "exposedMethods.length >
// 0", not a server-side flag to query on.
const query = computed(() => {
  const q: Record<string, unknown> = { type: type.value }
  if (schema.value !== 'all') {
    q.schema = schema.value
  }
  return q
})

// Not awaited (both loads): the table shows its own loading state, and an
// `await` here would stop defineExpose({ openDetail }) below from
// registering - the page's tree-driven "open this resource" relies on it.
const { data: resources, pending, error, refresh } = useAsyncData(
  'resources-browser',
  () => resourcesApi.list(query.value),
  { watch: [query], default: () => [] }
)

// A CREATE TABLE/VIEW/FUNCTION run in the "New resource" drawer needs the
// same catalog introspection refreshCatalog() below triggers manually for
// objects created outside TotalBase - do it automatically here so the new
// resource shows up without an extra click.
async function onResourceCreated(result: SqlExecuteResult) {
  if (result.status !== 'EXECUTED') return
  try {
    await api.post<CatalogRefreshResult>('/catalog/refresh')
    await Promise.all([refresh(), refreshResourcesList()])
  } catch {
    // The statement itself already succeeded and is visible in the drawer's
    // results panel - a failed catalog refresh just means the new object
    // won't show up here until the user hits Sync resources in the tree.
  }
}

// Independent of the active schema filter (unlike deriving it from
// `resources`, which is already filtered down) — otherwise picking one
// schema removes every other schema from this very list, locking the
// filter in place.
const { schemaNames } = useSchemasList()
const schemaOptions = computed(() => [
  { label: t('database.resourcesBrowser.allSchemas'), value: 'all' },
  ...schemaNames.value.map(s => ({ label: s, value: s }))
])

const sortedRows = computed(() => {
  const term = search.value.trim().toLowerCase()
  // Only ACTIVE resources — MISSING ones no longer exist in PostgreSQL
  // (see "Refresh catalog" to reconcile them away or back to ACTIVE).
  const list = (resources.value ?? []).filter(r =>
    r.status === 'ACTIVE'
    && (!term || r.name.toLowerCase().includes(term))
  )
  // Every row here is already the same type - name asc is the only sort
  // that means anything.
  return [...list].sort((a, b) => a.name.localeCompare(b.name) || a.schema.localeCompare(b.schema))
})

// --- Grouped function overloads (Specification_Admin_UI.md §11.5) ---
// Overloads share a name but are distinct resources (one OID each, their
// own exposure and page). The Functions list shows one row per
// schema-qualified name; a name with several overloads expands (open by
// default) to every signature, each still its own row's actions.
// Presentation only - nothing about a resource changes.
type BrowserRow = Resource & { overloads?: Resource[] }
const { data: functionArguments } = useAsyncData(
  'resources-browser-function-arguments',
  () => type.value === 'FUNCTION'
    ? api.get<{ oid: number, arguments: string }[]>('/catalog/functions').then(r => Object.fromEntries(r.data.map(fn => [fn.oid, fn.arguments])) as Record<number, string>)
    : Promise.resolve({} as Record<number, string>),
  { watch: [type, resources], default: () => ({} as Record<number, string>) }
)
function signatureOf(resource: Resource): string | null {
  const args = functionArguments.value?.[resource.postgresOid]
  return args === undefined ? null : `(${args})`
}
const displayRows = computed<BrowserRow[]>(() => {
  if (type.value !== 'FUNCTION') return sortedRows.value
  const groups = new Map<string, Resource[]>()
  for (const resource of sortedRows.value) {
    const key = `${resource.schema}.${resource.name}`
    groups.set(key, [...(groups.get(key) ?? []), resource])
  }
  return [...groups.values()].map((list) => {
    if (list.length === 1) return list[0]!
    const overloads = [...list].sort((a, b) => (signatureOf(a) ?? '').localeCompare(signatureOf(b) ?? ''))
    return { ...list[0]!, id: overloadGroupId(list[0]!), overloads }
  })
})
function overloadGroupId(resource: Resource): string {
  return `overloads:${resource.schema}.${resource.name}`
}
// Expanded unless the viewer folded it - keyed by group id, never `true`
// (UTable would expand every row, single ones included).
const collapsedGroups = ref(new Set<string>())
const expandedGroups = computed(() => Object.fromEntries(
  displayRows.value.filter(row => row.overloads && !collapsedGroups.value.has(row.id)).map(row => [row.id, true])
))
function toggleGroup(id: string) {
  const next = new Set(collapsedGroups.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  collapsedGroups.value = next
}
function onRowSelect(row: BrowserRow) {
  if (row.overloads) toggleGroup(row.id)
  else openDetail(row)
}

// Client-side pagination — the whole (filtered) result set is already in
// memory - most Admin API lists are small. Page size is a
// per-viewer preference (localStorage), not application state - it
// shouldn't reset to the default every time you reopen this page. One
// shared key now (not per-type): this is a single page browsing every
// type via the tree, not three separate pages that each kept their own.
const prefs = usePagePreferences('database-resources', { pageSize: 10 })
const page = ref(1)
const pageCount = computed(() => Math.max(1, Math.ceil(displayRows.value.length / prefs.pageSize)))
watch([search, schema, type], () => {
  page.value = 1
  rowSelection.value = {}
})
watch(() => prefs.pageSize, () => {
  page.value = 1
})
watch(pageCount, (count) => {
  if (page.value > count) page.value = count
})
const rows = computed(() => displayRows.value.slice((page.value - 1) * prefs.pageSize, page.value * prefs.pageSize))

const columns = computed(() => [
  { id: 'select', header: '', meta: { class: { th: 'w-10', td: 'w-10' } } },
  { accessorKey: 'name', header: t('common.name') },
  { id: 'methods', header: t('database.resourcesBrowser.methods') },
  { accessorKey: 'createdAt', header: t('database.resourcesBrowser.created') },
  { id: 'actions', header: '' }
])

// --- Row selection (toolbar's left zone switches from "New resource" to
// bulk actions once something's checked). Keyed by resource id via
// get-row-id so selection survives page navigation instead of drifting
// onto whatever row now sits at the same index.
const rowSelection = ref<Record<string, boolean>>({})
const selectedResources = computed(() => (resources.value ?? []).filter(r => rowSelection.value[r.id]))

function updateResource(id: string, patch: Partial<Resource>) {
  const idx = (resources.value ?? []).findIndex(r => r.id === id)
  if (idx !== -1 && resources.value) Object.assign(resources.value[idx]!, patch)
}

// Every resource has one canonical detail route (`/resources/{id}`);
// selection never defines a second route family.
function openDetail(resource: Resource) {
  navigateTo(`/resources/${resource.id}`)
}

// --- Endpoints (one modal: a checkbox per applicable HTTP method — a
// resource is exposed iff at least one is checked, no separate on/off
// flag) ---
const exposeTarget = ref<Resource | null>(null)
const isExposeOpen = computed({
  get: () => exposeTarget.value !== null,
  set: (open: boolean) => { if (!open) exposeTarget.value = null }
})
const exposing = ref(false)
// Seeded from the resource's current selection, or the full applicable set
// if it's never had any method chosen yet - avoids a first-time "Endpoints"
// open showing every box unchecked for no reason.
const exposeMethodsDraft = ref<DataApiMethod[]>([])

// TotalBase's own tables have a fixed exposure (Specification_Security.md §10.1)
// - access to them is decided by permissions alone.
function exposureFixed(resource: Resource): boolean {
  return resource.exposureFixed
}

function openExpose(resource: Resource) {
  exposeTarget.value = resource
  exposeMethodsDraft.value = resource.exposedMethods.length > 0 ? [...resource.exposedMethods] : [...APPLICABLE_METHODS[resource.type]]
}

async function saveEndpoints() {
  if (!exposeTarget.value) return
  const target = exposeTarget.value
  exposing.value = true
  try {
    // A minimum 1.5s "working" state so the confirmation reads as real work
    // being done (endpoint generation), not an instant flip.
    const [{ data }] = await Promise.all([
      api.patch<Resource>(`/resources/${target.id}`, { data: { exposedMethods: exposeMethodsDraft.value } }),
      new Promise(resolve => setTimeout(resolve, 1500))
    ])
    updateResource(target.id, { exposedMethods: data.exposedMethods })
    toast.add({ title: t('database.resourcesBrowser.endpointsUpdated'), color: 'success' })
    exposeTarget.value = null
  } catch (err) {
    notifyError(err, t('database.resourcesBrowser.updateResourceError'))
  } finally {
    exposing.value = false
  }
}

// --- Bulk Endpoints (same PATCH per resource, applied to every selected
// row) - only methods applicable to EVERY selected resource's type are
// offered, so e.g. a table+function selection never dangles a POST
// checkbox the function couldn't actually support. ---
const isBulkManageOpen = ref(false)
const bulkManaging = ref(false)
const bulkMethodsDraft = ref<DataApiMethod[]>([])

const bulkApplicableMethods = computed(() => {
  const types = [...new Set(selectedResources.value.map(r => r.type))]
  const [first, ...rest] = types.map(resourceType => APPLICABLE_METHODS[resourceType])
  if (!first) return []
  return rest.reduce((common, methods) => common.filter(m => methods.includes(m)), first)
})

function openBulkManage() {
  // Seeded with a logical AND per method across the whole selection: a
  // method starts checked only if every selected resource already has it
  // exposed, unchecked the moment even one doesn't - so a selection that's
  // already uniform (e.g. two tables both fully exposed) opens showing
  // that truthfully instead of blank. Saving still replaces each
  // resource's exposedMethods outright, it doesn't merge.
  bulkMethodsDraft.value = bulkApplicableMethods.value.filter(m =>
    selectedResources.value.every(r => r.exposedMethods.includes(m))
  )
  isBulkManageOpen.value = true
}

async function saveBulkManage() {
  const targets = selectedResources.value
  bulkManaging.value = true
  let failures = 0
  await Promise.all(targets.map(async (target) => {
    try {
      const { data } = await api.patch<Resource>(`/resources/${target.id}`, { data: { exposedMethods: bulkMethodsDraft.value } })
      updateResource(target.id, { exposedMethods: data.exposedMethods })
    } catch {
      failures += 1
    }
  }))
  bulkManaging.value = false
  isBulkManageOpen.value = false
  if (failures === 0) {
    toast.add({ title: t('database.resourcesBrowser.bulkUpdated', { n: targets.length }, targets.length), color: 'success' })
    rowSelection.value = {}
  } else {
    toast.add({
      title: t('database.resourcesBrowser.bulkPartial', { done: targets.length - failures, total: targets.length }),
      description: t('database.resourcesBrowser.bulkFailed', { n: failures }),
      color: 'warning'
    })
  }
}

// --- Delete - one modal for both a single row's "Delete" action and the
// toolbar's bulk Delete over a selection; a single row is just a
// one-element target list through the same flow (same confirmation, same
// sequential DROP loop) rather than two near-identical implementations. ---
const dropTargets = ref<Resource[]>([])
const isDropOpen = computed({
  get: () => dropTargets.value.length > 0,
  set: (open: boolean) => { if (!open) dropTargets.value = [] }
})
const dropCascade = ref(false)
const dropConfirmed = ref(false)
const dropping = ref(false)
const dropModalTitle = computed(() =>
  dropTargets.value.length === 1
    ? t(`database.resourcesBrowser.dropTitle.${COPY_KEY[dropTargets.value[0]!.type]}`)
    : t('database.resourcesBrowser.dropTitleMany', { n: dropTargets.value.length })
)

function openDrop(targets: Resource[]) {
  dropCascade.value = false
  dropConfirmed.value = false
  dropTargets.value = targets
}

async function confirmDrop() {
  const targets = dropTargets.value
  const qs = dropCascade.value ? '?cascade=true' : ''
  dropping.value = true
  const failed: string[] = []
  for (const target of targets) {
    try {
      if (target.type === 'TABLE') {
        await api.del(`/schema/${target.schema}/tables/${target.name}${qs}`)
      } else if (target.type === 'VIEW') {
        await api.del(`/schema/views/${target.id}${qs}`)
      } else {
        await api.del(`/schema/functions/${target.id}${qs}`)
      }
    } catch {
      failed.push(`${target.schema}.${target.name}`)
    }
  }
  dropping.value = false
  dropTargets.value = []
  rowSelection.value = {}
  await refresh()
  if (failed.length === 0) {
    toast.add({ title: t('database.resourcesBrowser.deleted', { n: targets.length }, targets.length), color: 'success' })
  } else {
    toast.add({
      title: t('database.resourcesBrowser.deletedPartial', { done: targets.length - failed.length, total: targets.length }),
      description: t('database.resourcesBrowser.deleteFailed', { names: failed.join(', ') }),
      color: 'warning'
    })
  }
}

// --- Activity sidebar ---
const activityTarget = ref<Resource | null>(null)
const isActivityOpen = computed({
  get: () => activityTarget.value !== null,
  set: (open: boolean) => { if (!open) activityTarget.value = null }
})
const activityLogs = ref<AuditLog[]>([])
const ACTIVITY_COLUMNS = computed<TableColumn<AuditLog>[]>(() => [
  { id: 'when', header: t('database.resourcesBrowser.when') },
  { id: 'action', header: t('database.resourcesBrowser.action') },
  { id: 'user', header: t('common.user') }
])
const activityLoading = ref(false)

async function openActivity(resource: Resource) {
  activityTarget.value = resource
  activityLoading.value = true
  activityLogs.value = []
  try {
    const { data } = await api.get<AuditLog[]>('/audit/logs', { resource: resource.id, limit: 50 })
    activityLogs.value = data
  } catch (err) {
    notifyError(err, t('database.resourcesBrowser.loadActivityError'))
  } finally {
    activityLoading.value = false
  }
}

function actionItems(resource: Resource) {
  return [
    [
      { label: t('database.resourcesBrowser.viewInfo'), icon: 'i-lucide-info', onSelect: () => openDetail(resource) },
      { label: t('database.resourcesBrowser.endpoints'), icon: 'i-lucide-plug-zap', disabled: exposureFixed(resource), onSelect: () => openExpose(resource) },
      // Tables have no CREATE OR REPLACE in PostgreSQL, so their Edit
      // opens TableDrawer (the structured ALTER TABLE editor +
      // read-only Data preview) instead of SQL Console's DDL-replace flow
      // that View/Function use.
      resource.type === 'TABLE'
        ? {
            label: t('common.edit'),
            icon: 'i-lucide-pencil',
            onSelect: () => {
              editTableTarget.value = resource
              isEditTableOpen.value = true
            }
          }
        : { label: t('common.edit'), icon: 'i-lucide-pencil', onSelect: () => openEditResource(resource) }
    ],
    [
      { label: t('database.resourcesBrowser.viewActivity'), icon: 'i-lucide-activity', onSelect: () => openActivity(resource) },
      { label: t('common.delete'), icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => openDrop([resource]) }
    ]
  ]
}

function typeColor(type: Resource['type']) {
  return RESOURCE_TYPE_STYLE[type].color
}

function methodColor(method: DataApiMethod) {
  return { GET: 'info', POST: 'success', PATCH: 'warning', DELETE: 'error' }[method] as 'info' | 'success' | 'warning' | 'error'
}

function actionColor(action: string) {
  if (action.includes('READ')) return 'info'
  if (action.includes('CREATE')) return 'success'
  if (action.includes('DELETE') || action.includes('DROP')) return 'error'
  return 'warning'
}

// Lets DatabaseTree.vue (via database/index.vue) jump straight to a
// resource's page on a leaf click, instead of only ever opening from an
// internal row click/dropdown action.
defineExpose({ openDetail })

// Suggest presentation for every table and view (Specification_DataViews.md §15.6) - a secondary action.
const schemaSuggestOpen = ref(false)
const headerActions = computed<HeaderAction[]>(() => (type.value === 'FUNCTION'
  ? []
  : [{ label: t('database.resourceSuggestPresentation.action'), icon: 'i-lucide-wand-sparkles', onSelect: () => (schemaSuggestOpen.value = true) }]))

// Header: the bulk actions while rows are selected. Sync resources lives
// in DatabaseTree, in sight on every Database page.
const headerSelection = computed<HeaderSelection>(() => ({
  count: selectedResources.value.length,
  actions: [
    { label: t('database.resourcesBrowser.manage'), icon: 'i-lucide-plug-zap', disabled: selectedResources.value.some(exposureFixed), onSelect: openBulkManage },
    { label: t('common.delete'), icon: 'i-lucide-trash-2', color: 'error', onSelect: () => openDrop(selectedResources.value) }
  ],
  onClear: () => {
    rowSelection.value = {}
  }
}))
</script>

<template>
  <PageShell>
    <SchemaSuggestPresentation v-model:open="schemaSuggestOpen" />
    <template #header>
      <PageHeader
        :title="copy.title"
        :description="copy.description"
        :selection="headerSelection"
        :actions="headerActions"
      >
        <template #search>
          <HeaderSearch
            v-model="search"
            :placeholder="t('database.resourcesBrowser.searchPlaceholder')"
            class="w-72"
          />
        </template>
        <template v-if="selectedResources.length === 0">
          <UDropdownMenu
            v-if="type === 'TABLE'"
            :items="NEW_RESOURCE_ITEMS"
            :ui="{ content: 'w-72' }"
          >
            <UButton
              icon="i-lucide-plus"
              :label="copy.newLabel"
              trailing-icon="i-lucide-chevron-down"
            />
          </UDropdownMenu>
          <UButton
            v-else
            icon="i-lucide-plus"
            :label="copy.newLabel"
            @click="openNewResource"
          />
        </template>
      </PageHeader>
    </template>

    <SqlConsoleDrawer
      v-model:open="isSqlConsoleOpen"
      :mode="sqlConsoleMode"
      :initial-sql="sqlConsoleInitialSql"
      :editing-label="sqlConsoleEditingLabel"
      @executed="onResourceCreated"
    />

    <NewTableModal
      v-model:open="isCreateTableOpen"
      @created="onTableCreated"
    />

    <TableDrawer
      v-model:open="isEditTableOpen"
      :resource="editTableTarget"
      @saved="refresh"
    />

    <!-- The schema filter - creating, bulk actions, search and sync live
    in the header (AGENTS.md section 25). -->
    <template #toolbar>
      <USelect
        v-model="schema"
        :items="schemaOptions"
        :aria-label="t('database.resourcesBrowser.schema')"
        class="w-full sm:w-40"
      />
    </template>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="error.message"
    />

    <div class="overflow-x-auto">
      <UTable
        v-model:row-selection="rowSelection"
        sticky
        :data="rows"
        :columns="columns"
        :loading="pending"
        :expanded="expandedGroups"
        :row-selection-options="{ enableRowSelection: (row: { original: BrowserRow }) => !row.original.overloads }"
        :get-row-id="(row: BrowserRow) => row.id"
        :on-select="(_event: Event, row: { original: BrowserRow }) => onRowSelect(row.original)"
      >
        <template #select-header="{ table }">
          <UCheckbox
            :model-value="table.getIsSomePageRowsSelected() ? 'indeterminate' : table.getIsAllPageRowsSelected()"
            :aria-label="t('database.resourcesBrowser.selectPage')"
            @update:model-value="(v: boolean | 'indeterminate') => table.toggleAllPageRowsSelected(v === true)"
            @click.stop
          />
        </template>
        <template #select-cell="{ row }">
          <UCheckbox
            v-if="!row.original.overloads"
            :model-value="row.getIsSelected()"
            :aria-label="t('database.resourcesBrowser.selectRow', { name: `${row.original.schema}.${row.original.name}` })"
            @update:model-value="(v: boolean | 'indeterminate') => row.toggleSelected(v === true)"
            @click.stop
          />
        </template>
        <template #name-cell="{ row }">
          <div class="flex flex-col cursor-pointer">
            <div class="flex items-center gap-2">
              <ResourceTypeIcon :type="row.original.type" />
              <span class="font-bold">{{ row.original.name }}</span>
              <span
                v-if="!row.original.overloads && signatureOf(row.original)"
                class="font-mono text-xs text-muted"
              >{{ signatureOf(row.original) }}</span>
              <UBadge
                v-if="row.original.overloads"
                color="neutral"
                variant="subtle"
                size="sm"
              >
                {{ t('database.resourcesBrowser.overloadCount', { n: row.original.overloads.length }) }}
              </UBadge>
            </div>
            <span class="text-xs text-muted ml-9">{{ row.original.schema }}</span>
          </div>
        </template>
        <template #expanded="{ row }">
          <ul
            class="flex flex-col divide-y divide-default ml-9"
            :aria-label="t('database.resourcesBrowser.overloadsOf', { name: `${row.original.schema}.${row.original.name}` })"
          >
            <li
              v-for="overload in row.original.overloads ?? []"
              :key="overload.id"
              class="flex items-center gap-3 py-1.5"
            >
              <UCheckbox
                :model-value="!!rowSelection[overload.id]"
                :aria-label="t('database.resourcesBrowser.selectRow', { name: `${overload.schema}.${overload.name}${signatureOf(overload) ?? ''}` })"
                @update:model-value="(v: boolean | 'indeterminate') => rowSelection = { ...rowSelection, [overload.id]: v === true }"
              />
              <ULink
                :to="`/resources/${overload.id}`"
                class="font-mono text-xs text-highlighted min-w-0 truncate"
              >
                {{ overload.name }}{{ signatureOf(overload) ?? '' }}
              </ULink>
              <div class="flex items-center gap-1 ml-auto">
                <UBadge
                  v-for="m in overload.exposedMethods"
                  :key="m"
                  :color="methodColor(m)"
                  variant="subtle"
                  size="sm"
                >
                  {{ m }}
                </UBadge>
                <span
                  v-if="overload.exposedMethods.length === 0"
                  class="text-muted"
                >—</span>
              </div>
              <UDropdownMenu :items="actionItems(overload)">
                <UButton
                  icon="i-lucide-ellipsis-vertical"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  :aria-label="t('database.resourcesBrowser.actionsFor', { name: `${overload.schema}.${overload.name}${signatureOf(overload) ?? ''}` })"
                />
              </UDropdownMenu>
            </li>
          </ul>
        </template>
        <template #methods-cell="{ row }">
          <template v-if="row.original.overloads" />
          <div
            v-else-if="row.original.exposedMethods.length > 0"
            class="flex items-center gap-1"
          >
            <UBadge
              v-for="m in row.original.exposedMethods"
              :key="m"
              :color="methodColor(m)"
              variant="subtle"
              size="sm"
            >
              {{ m }}
            </UBadge>
          </div>
          <span
            v-else
            class="text-muted"
          >—</span>
        </template>
        <template #createdAt-cell="{ row }">
          <span
            v-if="!row.original.overloads"
            class="text-muted whitespace-nowrap"
          >{{ dates.date(row.original.createdAt) }}</span>
        </template>
        <template #actions-cell="{ row }">
          <UButton
            v-if="row.original.overloads"
            :icon="row.getIsExpanded() ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
            color="neutral"
            variant="ghost"
            size="xs"
            :aria-label="row.getIsExpanded() ? t('database.resourcesBrowser.hideOverloads', { name: `${row.original.schema}.${row.original.name}` }) : t('database.resourcesBrowser.showOverloads', { name: `${row.original.schema}.${row.original.name}` })"
            :aria-expanded="row.getIsExpanded()"
            @click.stop="toggleGroup(row.original.id)"
          />
          <UDropdownMenu
            v-else
            :items="actionItems(row.original)"
          >
            <UButton
              icon="i-lucide-ellipsis-vertical"
              color="neutral"
              variant="ghost"
              size="xs"
              :aria-label="t('database.resourcesBrowser.actionsFor', { name: `${row.original.schema}.${row.original.name}` })"
              @click.stop
            />
          </UDropdownMenu>
        </template>
      </UTable>
    </div>

    <template #footer>
      <TablePager
        v-model:page="page"
        v-model:page-size="prefs.pageSize"
        :total="displayRows.length"
        :noun="t('database.resourcesBrowser.pagerNoun')"
        :plural="t('database.resourcesBrowser.pagerPlural')"
      />
    </template>

    <!-- Endpoints -->
    <UModal
      v-model:open="isExposeOpen"
      :title="t('database.resourcesBrowser.endpoints')"
    >
      <template #body>
        <div
          v-if="exposeTarget"
          class="flex flex-col gap-4"
        >
          <i18n-t
            keypath="database.resourcesBrowser.exposeIntro"
            tag="p"
            class="text-sm text-muted"
          >
            <template #name>
              <span class="font-medium text-default">{{ exposeTarget.schema }}.{{ exposeTarget.name }}</span>
            </template>
          </i18n-t>

          <div class="flex flex-wrap gap-3">
            <label
              v-for="m in APPLICABLE_METHODS[exposeTarget.type]"
              :key="m"
              class="flex items-center gap-1.5 text-sm"
            >
              <UCheckbox
                :model-value="exposeMethodsDraft.includes(m)"
                @update:model-value="(v: boolean | 'indeterminate') => { exposeMethodsDraft = v === true ? [...exposeMethodsDraft, m] : exposeMethodsDraft.filter(x => x !== m) }"
              />
              {{ m }}
            </label>
          </div>

          <div class="flex justify-end gap-2">
            <UButton
              :label="t('common.cancel')"
              color="neutral"
              variant="ghost"
              :disabled="exposing"
              @click="exposeTarget = null"
            />
            <UButton
              :label="exposing ? t('database.resourcesBrowser.working') : t('common.save')"
              :loading="exposing"
              @click="saveEndpoints"
            />
          </div>
        </div>
      </template>
    </UModal>

    <!-- Activity -->
    <USlideover
      v-model:open="isActivityOpen"
      :title="activityTarget ? t('database.resourcesBrowser.activityTitle', { name: `${activityTarget.schema}.${activityTarget.name}` }) : t('database.resourcesBrowser.activity')"
    >
      <template #body>
        <UEmpty
          v-if="activityLoading"
          loading
          variant="naked"
          size="sm"
        />
        <UEmpty
          v-else-if="activityLogs.length === 0"
          variant="naked"
          size="sm"
          icon="i-lucide-history"
          :title="t('database.resourcesBrowser.noActivity')"
        />
        <UTable
          v-else
          sticky
          :data="activityLogs"
          :columns="ACTIVITY_COLUMNS"
        >
          <template #when-cell="{ row: { original: log } }">
            {{ dates.dateTime(log.createdAt) }}
          </template>
          <template #action-cell="{ row: { original: log } }">
            <UBadge
              :color="actionColor(log.action)"
              variant="subtle"
              size="sm"
            >
              {{ log.action }}
            </UBadge>
          </template>
          <template #user-cell="{ row: { original: log } }">
            {{ log.principalType }}<template v-if="log.principalId">
              — {{ log.principalId }}
            </template>
          </template>
        </UTable>
      </template>
    </USlideover>

    <!-- Delete - one row's "Delete" action and the toolbar's bulk Delete
    both land here (openDrop takes a list either way; a single row is just
    a one-element list). -->
    <UModal
      v-model:open="isDropOpen"
      :title="dropModalTitle"
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <p class="text-sm text-muted">
            {{ t('database.resourcesBrowser.dropIntro') }}
          </p>
          <ul class="flex flex-col gap-1 max-h-48 overflow-y-auto border border-default rounded-lg p-2">
            <li
              v-for="r in dropTargets"
              :key="r.id"
              class="flex items-center gap-2 text-sm"
            >
              <UBadge
                :color="typeColor(r.type)"
                variant="subtle"
                size="sm"
              >
                {{ r.type }}
              </UBadge>
              <span class="font-mono">{{ r.schema }}.{{ r.name }}</span>
            </li>
          </ul>
          <div class="flex items-center gap-2">
            <USwitch v-model="dropCascade" />
            <span class="text-sm">{{ t('database.resourcesBrowser.cascade') }}</span>
          </div>
          <div class="flex items-center justify-between gap-2 border-t border-default pt-4">
            <label class="flex items-center gap-2 cursor-pointer">
              <UCheckbox v-model="dropConfirmed" />
              <span class="text-sm">{{ t('common.confirm') }}</span>
            </label>
            <div class="flex gap-2">
              <UButton
                :label="t('common.cancel')"
                color="neutral"
                variant="ghost"
                :disabled="dropping"
                @click="dropTargets = []"
              />
              <UButton
                :label="t('common.delete')"
                color="error"
                :disabled="!dropConfirmed"
                :loading="dropping"
                @click="confirmDrop"
              />
            </div>
          </div>
        </div>
      </template>
    </UModal>

    <!-- Bulk Endpoints -->
    <UModal
      v-model:open="isBulkManageOpen"
      :title="t('database.resourcesBrowser.endpoints')"
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <i18n-t
            keypath="database.resourcesBrowser.bulkIntro"
            tag="p"
            class="text-sm text-muted"
          >
            <template #count>
              <span class="font-medium text-default">{{ selectedResources.length }}</span>
            </template>
          </i18n-t>

          <div
            v-if="bulkApplicableMethods.length === 0"
            class="text-sm text-muted"
          >
            {{ t('database.resourcesBrowser.bulkNoMethods') }}
          </div>
          <div
            v-else
            class="flex flex-wrap gap-3"
          >
            <label
              v-for="m in bulkApplicableMethods"
              :key="m"
              class="flex items-center gap-1.5 text-sm"
            >
              <UCheckbox
                :model-value="bulkMethodsDraft.includes(m)"
                @update:model-value="(v: boolean | 'indeterminate') => { bulkMethodsDraft = v === true ? [...bulkMethodsDraft, m] : bulkMethodsDraft.filter(x => x !== m) }"
              />
              {{ m }}
            </label>
          </div>

          <div class="flex justify-end gap-2">
            <UButton
              :label="t('common.cancel')"
              color="neutral"
              variant="ghost"
              :disabled="bulkManaging"
              @click="isBulkManageOpen = false"
            />
            <UButton
              :label="bulkManaging ? t('database.resourcesBrowser.working') : t('common.save')"
              :disabled="bulkApplicableMethods.length === 0"
              :loading="bulkManaging"
              @click="saveBulkManage"
            />
          </div>
        </div>
      </template>
    </UModal>
  </PageShell>
</template>
