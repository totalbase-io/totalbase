<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import { curlCommand, requestBodyExample, type OpenApiDocumentLike } from '~/utils/openapi-example'
import { apiHeaders } from '~/utils/api-headers'

type EndpointKind = 'TABLE' | 'VIEW' | 'FUNCTION' | 'WORKFLOW' | 'SYSTEM'

/** GET /admin/api/endpoints - @totalbase/openapi's ApiEndpoint. */
interface Endpoint {
  method: string
  path: string
  kind: EndpointKind
  name: string
  schema: string | null
  resource: string | null
  workflow: string | null
  enabled: boolean
  access: 'public' | 'session' | 'principal'
  tag: string
}

const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const session = useSession()

// Every route a developer can call: each exposed resource's (a method it
// doesn't expose listed as disabled), each HTTP-triggered workflow's, and
// the fixed /api/* routes - Admin_UI.md §12.
const { data: endpoints, pending, error, refresh } = await useAsyncData(
  'endpoints',
  async () => (await api.get<Endpoint[]>('/endpoints')).data,
  { default: () => [] }
)

const refreshing = ref(false)
async function refreshEndpoints() {
  refreshing.value = true
  try {
    await refresh()
    exampleDocument.value = null
  } finally {
    refreshing.value = false
  }
}

// GET /auth/me resolves system.public_url (with its env fallback) - the
// canonical external URL, never this browser's own origin (AGENTS.md §19A).
const publicUrl = computed(() => String(session.admin.value?.publicUrl ?? '').replace(/\/+$/, ''))
const urlOf = (endpoint: Endpoint) => `${publicUrl.value}${endpoint.path}`

const ENDPOINT_KINDS: EndpointKind[] = ['TABLE', 'VIEW', 'FUNCTION', 'WORKFLOW', 'SYSTEM']
const typeLabel = (kind: EndpointKind) => t(`content.docs.endpoints.kinds.${kind}`)

type StatusFilter = 'ACTIVE' | 'DISABLED' | 'ALL'
const STATUS_FILTERS = computed<Array<{ value: StatusFilter, label: string }>>(() => [
  { value: 'ACTIVE', label: t('common.active') },
  { value: 'DISABLED', label: t('common.disabled') },
  { value: 'ALL', label: t('common.all') }
])
const status = ref<StatusFilter>('ACTIVE')
const matchesStatus = (endpoint: Endpoint, filter: StatusFilter) =>
  filter === 'ALL' || (filter === 'ACTIVE') === endpoint.enabled

const search = ref('')
const methodFilter = ref('ALL')
const typeFilter = ref<EndpointKind | 'ALL'>('ALL')
const schemaFilter = ref('ALL')
const optionsOf = (all: string, values: string[], label: (value: string) => string = value => value) => [
  { label: all, value: 'ALL' },
  ...Array.from(new Set(values)).sort().map(value => ({ label: label(value), value }))
]
const methodOptions = computed(() => optionsOf(t('content.docs.endpoints.allMethods'), endpoints.value.map(e => e.method)))
const typeOptions = computed(() => [
  { label: t('content.docs.endpoints.allTypes'), value: 'ALL' },
  ...ENDPOINT_KINDS
    .filter(kind => endpoints.value.some(e => e.kind === kind))
    .map(kind => ({ label: typeLabel(kind), value: kind }))
])
const schemaOptions = computed(() => optionsOf(t('content.docs.endpoints.allSchemas'), endpoints.value.flatMap(e => e.schema ? [e.schema] : [])))

// Search and the selects narrow first, so the status counts describe what's on screen.
const searchedRows = computed(() => {
  const term = search.value.trim().toLowerCase()
  return endpoints.value.filter((e) => {
    if (methodFilter.value !== 'ALL' && e.method !== methodFilter.value) return false
    if (typeFilter.value !== 'ALL' && e.kind !== typeFilter.value) return false
    if (schemaFilter.value !== 'ALL' && e.schema !== schemaFilter.value) return false
    if (!term) return true
    return [e.name, e.schema ?? '', e.method, e.path, typeLabel(e.kind), e.tag].some(value => value.toLowerCase().includes(term))
  })
})
const countOf = (filter: StatusFilter) => searchedRows.value.filter(e => matchesStatus(e, filter)).length
const filteredRows = computed(() => searchedRows.value.filter(e => matchesStatus(e, status.value)))

// Client-side pagination - the whole list is one small response; page size
// is a per-viewer preference.
const prefs = usePagePreferences('endpoints', { pageSize: 10 })
const page = ref(1)
const pageCount = computed(() => Math.max(1, Math.ceil(filteredRows.value.length / prefs.pageSize)))
watch([search, methodFilter, typeFilter, schemaFilter, status], () => {
  page.value = 1
})
watch(() => prefs.pageSize, () => {
  page.value = 1
})
watch(pageCount, (count) => {
  if (page.value > count) page.value = count
})
const pagedRows = computed(() => filteredRows.value.slice((page.value - 1) * prefs.pageSize, page.value * prefs.pageSize))

const columns = computed(() => [
  { accessorKey: 'method', header: t('content.docs.endpoints.method') },
  { id: 'name', header: t('common.name') },
  { id: 'type', header: t('common.type') },
  { id: 'url', header: t('content.docs.endpoints.endpoint') },
  { id: 'status', header: t('common.status') },
  { id: 'actions', header: '' }
])

function methodColor(method: string) {
  return ({ GET: 'info', POST: 'success', PATCH: 'warning', PUT: 'warning', DELETE: 'error' } as const)[method] ?? 'neutral'
}

async function copy(text: string, title: string) {
  await navigator.clipboard.writeText(text)
  toast.add({ title, color: 'success' })
}

// The Data API document as the Administrators role sees it - every exposed
// resource, action and column, every workflow and fixed route - is where
// both a cURL's body and "Open in API docs" come from. Fetched on first use.
const { data: roles } = await useRoleOptions()
const administratorsRole = computed(() => roles.value.find(role => role.adminAccess)?.id)
const exampleDocument = ref<OpenApiDocumentLike | null>(null)
async function loadExampleDocument(): Promise<OpenApiDocumentLike | null> {
  if (exampleDocument.value || !administratorsRole.value) return exampleDocument.value
  exampleDocument.value = await $fetch<OpenApiDocumentLike>(`/admin/api/openapi/data?role=${encodeURIComponent(administratorsRole.value)}`, {
    headers: apiHeaders(session.token.value)
  })
  return exampleDocument.value
}

const BODY_METHODS = new Set(['POST', 'PATCH', 'PUT'])
async function copyCurl(endpoint: Endpoint) {
  let body: unknown
  if (BODY_METHODS.has(endpoint.method)) {
    try {
      body = requestBodyExample(await loadExampleDocument(), endpoint.method, endpoint.path)
    } catch {
      // No example body is still a usable command.
    }
    // A disabled method isn't in the document: still show the envelope.
    if (body === undefined && endpoint.kind !== 'SYSTEM') body = { data: {} }
  }
  await copy(curlCommand({ method: endpoint.method, url: urlOf(endpoint), authenticated: endpoint.access !== 'public', body }), t('content.docs.endpoints.curlCopied'))
}

function rowMenu(endpoint: Endpoint): DropdownMenuItem[][] {
  const open: DropdownMenuItem[] = [
    ...(endpoint.resource ? [{ label: t('content.docs.endpoints.viewResource'), icon: 'i-lucide-database', to: `/resources/${endpoint.resource}` }] : []),
    ...(endpoint.workflow ? [{ label: t('content.docs.endpoints.viewWorkflow'), icon: 'i-lucide-workflow', to: `/workflows/${endpoint.workflow}` }] : []),
    {
      label: t('content.docs.endpoints.openInDocs'),
      icon: 'i-lucide-file-code',
      // Only what answers is in the document.
      disabled: !endpoint.enabled || !administratorsRole.value,
      to: { path: '/docs/openapi', query: { document: 'data', role: administratorsRole.value, path: endpoint.path } }
    }
  ]
  return [
    [
      { label: t('content.templates.editor.copyUrl'), icon: 'i-lucide-link', onSelect: () => copy(urlOf(endpoint), t('content.docs.endpoints.urlCopied')) },
      { label: t('content.docs.endpoints.copyCurl'), icon: 'i-lucide-terminal', onSelect: () => copyCurl(endpoint) }
    ],
    open
  ]
}
</script>

<template>
  <PageShell>
    <template #header>
      <PageHeader
        :title="t('content.docs.endpoints.title')"
        :description="t('content.docs.endpoints.description')"
        :actions="[{ label: t('content.docs.endpoints.refresh'), icon: 'i-lucide-refresh-cw', iconOnly: true, loading: refreshing, onSelect: refreshEndpoints }]"
      >
        <template #search>
          <HeaderSearch
            v-model="search"
            :placeholder="t('content.docs.endpoints.searchPlaceholder')"
            class="w-72"
          />
        </template>
      </PageHeader>
    </template>

    <!-- Read-only, derived data: only filters here; search and refresh are in the header. -->
    <template #toolbar>
      <div class="flex flex-wrap items-center gap-3">
        <UFieldGroup>
          <UButton
            v-for="f in STATUS_FILTERS"
            :key="f.value"
            :label="`${f.label} ${countOf(f.value)}`"
            :color="status === f.value ? 'primary' : 'neutral'"
            :variant="status === f.value ? 'soft' : 'outline'"
            @click="status = f.value"
          />
        </UFieldGroup>

        <USelect
          v-model="methodFilter"
          :items="methodOptions"
          value-key="value"
          :aria-label="t('content.docs.endpoints.method')"
          class="w-36"
        />
        <USelect
          v-model="typeFilter"
          :items="typeOptions"
          value-key="value"
          :aria-label="t('common.type')"
          class="w-36"
        />
        <USelect
          v-if="schemaOptions.length > 2"
          v-model="schemaFilter"
          :items="schemaOptions"
          value-key="value"
          :aria-label="t('content.docs.endpoints.schema')"
          class="w-40"
        />
      </div>
    </template>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="error.message"
    />

    <div class="overflow-x-auto">
      <UTable
        sticky
        :data="pagedRows"
        :columns="columns"
        :loading="pending"
      >
        <template #method-cell="{ row }">
          <UBadge
            :color="methodColor(row.original.method)"
            variant="subtle"
            size="sm"
          >
            {{ row.original.method }}
          </UBadge>
        </template>
        <template #name-cell="{ row }">
          <div class="flex flex-col">
            <span class="font-medium">{{ row.original.name }}</span>
            <span class="text-xs text-muted">{{ row.original.schema ?? row.original.tag }}</span>
          </div>
        </template>
        <template #type-cell="{ row }">
          <span class="text-sm text-muted">{{ typeLabel(row.original.kind) }}</span>
        </template>
        <template #url-cell="{ row }">
          <div class="flex items-center gap-1">
            <span
              class="font-mono text-xs"
              :class="{ 'text-muted': !row.original.enabled }"
            >{{ urlOf(row.original) }}</span>
            <UTooltip :text="t('content.templates.editor.copyUrl')">
              <UButton
                icon="i-lucide-copy"
                size="xs"
                color="neutral"
                variant="ghost"
                :aria-label="t('content.templates.editor.copyUrl')"
                @click="copy(urlOf(row.original), t('content.docs.endpoints.urlCopied'))"
              />
            </UTooltip>
          </div>
        </template>
        <template #status-cell="{ row }">
          <div class="flex items-center gap-1">
            <UBadge
              :color="row.original.enabled ? 'success' : 'neutral'"
              variant="subtle"
              size="sm"
            >
              {{ row.original.enabled ? t('common.active') : t('common.disabled') }}
            </UBadge>
            <UTooltip
              v-if="row.original.access === 'public'"
              :text="t('content.docs.endpoints.noCredentials')"
            >
              <UBadge
                color="warning"
                variant="subtle"
                size="sm"
              >
                {{ t('content.docs.endpoints.public') }}
              </UBadge>
            </UTooltip>
          </div>
        </template>
        <template #actions-cell="{ row }">
          <UDropdownMenu
            :items="rowMenu(row.original)"
            :content="{ align: 'end' }"
          >
            <UButton
              icon="i-lucide-ellipsis-vertical"
              size="xs"
              color="neutral"
              variant="ghost"
              :aria-label="t('content.docs.endpoints.rowActions')"
            />
          </UDropdownMenu>
        </template>
        <template #empty>
          <UEmpty
            variant="naked"
            icon="i-lucide-route"
            :title="t('content.docs.endpoints.emptyTitle')"
            :description="t('content.docs.endpoints.emptyDescription')"
          />
        </template>
      </UTable>
    </div>

    <template #footer>
      <TablePager
        v-model:page="page"
        v-model:page-size="prefs.pageSize"
        :total="filteredRows.length"
        :noun="t('content.docs.endpoints.pagerNoun')"
        :plural="t('content.docs.endpoints.pagerPlural')"
      />
    </template>
  </PageShell>
</template>
