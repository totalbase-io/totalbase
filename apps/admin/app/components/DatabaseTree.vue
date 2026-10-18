<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import type { CatalogRefreshResult, Resource, ResourceType } from '~/types/resource'
import { useBrokenReferences } from '~/composables/useBrokenReferences'

const selection = useDatabaseSelection()
const api = useAdminApi()
const { t } = useI18n()
const toast = useToast()
const notifyError = useErrorToast()

// The shared registry and schema list (useResourcesList's convention) - the pages
// that change them (a table created or dropped, a sync) refresh those same keys.
const { resources, error, refresh: refreshResources } = useResourcesList()
const { schemaNames, refresh: refreshSchemas } = useSchemasList()

const schema = ref('public')
const resourceSearch = ref('')
const sqlConsolePrefill = useSqlConsolePrefill()
const schemaOptions = computed(() => schemaNames.value.map(value => ({ label: value, value })))

watch(schema, () => {
  resourceSearch.value = ''
})

const resourcesForSchema = computed(() => (resources.value ?? [])
  .filter((resource) => {
    if (resource.status !== 'ACTIVE' || resource.schema !== schema.value) return false
    const query = resourceSearch.value.trim().toLocaleLowerCase()
    return !query || resource.name.toLocaleLowerCase().includes(query)
  })
  .sort((a, b) => a.name.localeCompare(b.name)))

const resourcesByType = computed<Record<ResourceType, Resource[]>>(() => ({
  TABLE: resourcesForSchema.value.filter(resource => resource.type === 'TABLE'),
  VIEW: resourcesForSchema.value.filter(resource => resource.type === 'VIEW'),
  FUNCTION: resourcesForSchema.value.filter(resource => resource.type === 'FUNCTION')
}))

const resourceGroups = computed<{ type: ResourceType, label: string, empty: string }[]>(() => (['TABLE', 'VIEW', 'FUNCTION'] as const).map(type => ({
  type,
  label: t(`database.databaseTree.groups.${type}`),
  empty: t(`database.databaseTree.empty.${type}`)
})))

function refreshDatabase() {
  refreshResources()
  refreshSchemas()
}

// Picks up tables, views and functions created outside TotalBase (psql,
// migrations) without waiting for catalog.refresh_interval_minutes. Here,
// beside New and Console, so it is in sight on every Database page; the
// Resources list (ResourcesBrowser's 'resources-browser') reloads too.
const syncingCatalog = ref(false)

const brokenReferences = useBrokenReferences()
async function syncCatalog() {
  syncingCatalog.value = true
  try {
    const { data } = await api.post<CatalogRefreshResult>('/catalog/refresh')
    toast.add({
      title: t('database.databaseTree.catalogRefreshed'),
      description: t('database.databaseTree.catalogRefreshedDescription', { discovered: data.discovered, reactivated: data.reactivated, missing: data.missing, purged: data.purged, columns: data.columns.discovered }),
      color: 'success'
    })
    refreshDatabase()
    refreshNuxtData('resources-browser')
    // Something gone: what still names it - the trees' icons, and a word here.
    if (data.brokenReferences) {
      brokenReferences.state.value = data.brokenReferences
      const count = data.brokenReferences.dashboards.length + data.brokenReferences.dataviews.length
      if (count > 0) toast.add({ title: t('database.resourceColumns.brokenTitle', { count }, count), description: t('database.resourceColumns.brokenDescription'), color: 'warning' })
    }
  } catch (err) {
    notifyError(err, t('database.databaseTree.catalogRefreshError'))
  } finally {
    syncingCatalog.value = false
  }
}

function onTableCreated(resource: { id: string | null, oid: number | null }) {
  refreshDatabase()
  if (resource.id !== null) navigateTo(`/resources/${resource.id}`)
}

async function selectResource(resource: Resource) {
  if (resource.type === 'TABLE') {
    navigateTo(`/resources/${resource.id}`)
    return
  }
  if (resource.type === 'VIEW') {
    sqlConsolePrefill.value = null
    await navigateTo(`/resources/${resource.id}`)
    return
  }
  if (resource.type === 'FUNCTION') {
    sqlConsolePrefill.value = null
    await navigateTo(`/resources/${resource.id}`)
    return
  }
  selection.value = {
    schema: resource.schema,
    type: resource.type,
    openResource: resource,
    touched: true
  }
}

/** A category heading: the Resources list (pages/resources/index.vue), filtered to it - from a table's page too. */
function selectGroup(type: ResourceType) {
  selection.value = { schema: schema.value, type, openResource: null, touched: true }
  navigateTo('/resources')
}

function openSqlConsole() {
  sqlConsolePrefill.value = null
  navigateTo('/sql-console')
}

const isNewSchemaOpen = ref(false)
const isCreateTableOpen = ref(false)
type SqlConsoleIntent = 'view' | 'function'
const sqlConsoleIntent = ref<SqlConsoleIntent | null>(null)
const isSqlConsoleOpen = computed({
  get: () => sqlConsoleIntent.value !== null,
  set: (open: boolean) => { if (!open) sqlConsoleIntent.value = null }
})
const SQL_CONSOLE_SKELETON: Record<SqlConsoleIntent, string> = {
  view: '-- CREATE VIEW <schema>.<name> AS\n-- SELECT ...\n',
  function: '-- CREATE FUNCTION <schema>.<name>(...) RETURNS ...\n-- LANGUAGE sql AS $$\n--   ...\n-- $$;\n'
}
const sqlConsoleInitialSql = computed(() => sqlConsoleIntent.value ? SQL_CONSOLE_SKELETON[sqlConsoleIntent.value] : '')

function openCreateSqlConsole(intent: SqlConsoleIntent) {
  sqlConsoleIntent.value = intent
}
const createMenu = computed<DropdownMenuItem[][]>(() => [
  [
    { label: t('database.databaseTree.newView'), icon: RESOURCE_TYPE_STYLE.VIEW.icon, onSelect: () => openCreateSqlConsole('view') },
    { label: t('database.databaseTree.newFunction'), icon: RESOURCE_TYPE_STYLE.FUNCTION.icon, onSelect: () => openCreateSqlConsole('function') }
  ],
  [{ label: t('database.databaseTree.newSchema'), icon: 'i-lucide-folder-plus', onSelect: () => { isNewSchemaOpen.value = true } }]
])
</script>

<template>
  <div class="flex flex-col gap-3">
    <!-- What gets created most - a table - by name; the rest of "new" in
    its menu; SQL Console beside it, since it creates nothing by itself. -->
    <div class="flex items-center gap-2">
      <UFieldGroup class="min-w-0 flex-1">
        <UButton
          icon="i-lucide-plus"
          :label="t('database.databaseTree.newTable')"
          class="flex-1 justify-center"
          @click="isCreateTableOpen = true"
        />
        <UDropdownMenu
          :items="createMenu"
          :content="{ align: 'end' }"
        >
          <UButton
            icon="i-lucide-chevron-down"
            :aria-label="t('database.databaseTree.moreNew')"
          />
        </UDropdownMenu>
      </UFieldGroup>
      <UTooltip :text="t('database.databaseTree.console')">
        <UButton
          icon="i-lucide-square-terminal"
          :aria-label="t('database.databaseTree.console')"
          color="neutral"
          variant="outline"
          @click="openSqlConsole"
        />
      </UTooltip>
      <UTooltip :text="t('database.databaseTree.syncResourcesTooltip')">
        <UButton
          icon="i-lucide-refresh-cw"
          :aria-label="t('database.databaseTree.syncResources')"
          :loading="syncingCatalog"
          color="neutral"
          variant="outline"
          @click="syncCatalog"
        />
      </UTooltip>
    </div>

    <USelect
      v-model="schema"
      :items="schemaOptions"
      value-key="value"
      class="w-full"
      :aria-label="t('database.databaseTree.schema')"
    />

    <UInput
      v-model="resourceSearch"
      icon="i-lucide-search"
      :aria-label="t('database.databaseTree.searchResources')"
      class="w-full"
    />

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="t('database.databaseTree.loadError')"
    />
    <div
      v-else
      class="flex flex-col gap-4"
    >
      <section
        v-for="group in resourceGroups"
        :key="group.type"
      >
        <button
          type="button"
          class="flex w-full items-center pb-2 text-left text-xs font-medium uppercase tracking-wide text-muted hover:text-highlighted"
          @click="selectGroup(group.type)"
        >
          <span>{{ group.label }}</span>
          <span class="ms-auto text-xs font-normal text-muted">{{ resourcesByType[group.type].length }}</span>
        </button>
        <div
          v-if="resourcesByType[group.type].length"
          class="mt-1 flex flex-col"
        >
          <button
            v-for="resource in resourcesByType[group.type]"
            :key="resource.id"
            type="button"
            class="flex items-center gap-2 rounded px-3 py-2 text-left text-sm text-default hover:bg-elevated hover:text-highlighted"
            @click="selectResource(resource)"
          >
            <UIcon
              :name="RESOURCE_TYPE_STYLE[group.type].icon"
              class="size-4 shrink-0"
              :class="resource.exposedMethods.length > 0 ? 'text-primary' : 'text-muted'"
            />
            <span class="truncate">{{ resource.name }}</span>
          </button>
        </div>
        <p
          v-else
          class="px-2 py-2 text-xs text-muted"
        >
          {{ group.empty }}
        </p>
      </section>
    </div>

    <NewSchemaModal
      v-model:open="isNewSchemaOpen"
      @created="refreshDatabase"
    />
    <NewTableModal
      v-model:open="isCreateTableOpen"
      :default-schema="schema"
      @created="onTableCreated"
    />
    <SqlConsoleDrawer
      v-model:open="isSqlConsoleOpen"
      mode="create"
      :initial-sql="sqlConsoleInitialSql"
      @executed="refreshDatabase"
    />
  </div>
</template>
