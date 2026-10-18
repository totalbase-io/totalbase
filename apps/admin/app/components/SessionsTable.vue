<script setup lang="ts">
/**
 * Sessions - the global view (pages/sessions.vue, every user's), a
 * user's Sessions tab (pages/users/[id].vue, `userId`) and the signed-in
 * user's own (My account, `self` - /app/api/me/sessions, any portal user)
 * share this grid.
 * Sessions grow with every sign-in, so paging, the status filter, the
 * counts and the search all run in PostgreSQL (GET /sessions?limit=...) -
 * never the whole list. Active sessions by default.
 *
 * Each row names its device from the user agent ("Chrome on Linux", the
 * raw string on hover), with the IP beneath; the caller's own session is
 * marked "This session" and never part of a bulk revoke - revoking it
 * alone signs the admin out. There's no revoke-everything button: filter,
 * select, revoke (and a user's page has "Revoke all sessions" for one
 * account).
 */
import { formatDistanceToNow } from 'date-fns'
import type { Session } from '~/types/security'

const props = defineProps<{
  userId?: string
  /** My account: the caller's own sessions through /app/api/me - no user column, no admin routes. */
  self?: boolean
  /** The global page's PageHeader (title/description/icon). */
  header?: { title: string, description?: string, icon?: string }
}>()

const api = useAdminApi()
const appApi = useAppApi()
const toast = useToast()
const session = useSession()
const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const notifyError = useErrorToast()
const ui = useUiLocale()

type SessionStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'ALL'
const STATUS_FILTERS = computed<Array<{ value: SessionStatus, label: string }>>(() => [
  { value: 'ACTIVE', label: t('users.sessions.filter.ACTIVE') },
  { value: 'EXPIRED', label: t('users.sessions.filter.EXPIRED') },
  { value: 'REVOKED', label: t('users.sessions.filter.REVOKED') },
  { value: 'ALL', label: t('users.sessions.filter.ALL') }
])

// The global page keeps its filter in the URL (shareable); a user's tab
// just remembers it locally.
const localStatus = ref<SessionStatus>('ACTIVE')
const status = computed<SessionStatus>({
  get: () => props.header
    ? (STATUS_FILTERS.value.find(f => f.value === route.query.status)?.value ?? 'ACTIVE')
    : localStatus.value,
  set: (value) => {
    if (props.header) router.replace({ query: { ...route.query, status: value === 'ACTIVE' ? undefined : value } })
    else localStatus.value = value
  }
})

// Search is debounced - it runs in PostgreSQL, not on every keystroke.
const search = ref('')
const query = useDebouncedRef(() => search.value.trim())
const prefs = usePagePreferences('sessions', { pageSize: 20 })
const page = ref(1)
watch([status, query, () => prefs.pageSize], () => {
  page.value = 1
})

const { data: result, pending, error, refresh: refreshList } = await useAsyncData(
  props.self ? 'sessions-me' : props.userId ? `sessions-${props.userId}` : 'sessions',
  () => {
    const params = {
      status: status.value,
      ...(query.value && { q: query.value }),
      limit: prefs.pageSize,
      offset: (page.value - 1) * prefs.pageSize
    }
    return props.self
      ? appApi.get<Session[]>('/me/sessions', params)
      : api.get<Session[]>('/sessions', { ...(props.userId && { user: props.userId }), ...params })
  },
  { watch: [status, query, page, () => prefs.pageSize] }
)
const rows = computed(() => result.value?.data ?? [])
const total = computed(() => (result.value?.meta?.total as number | undefined) ?? 0)
const counts = computed(() => (result.value?.meta?.counts as Record<Exclude<SessionStatus, 'ALL'>, number> | undefined)
  ?? { ACTIVE: 0, EXPIRED: 0, REVOKED: 0 })
const countOf = (value: SessionStatus) => value === 'ALL' ? counts.value.ACTIVE + counts.value.EXPIRED + counts.value.REVOKED : counts.value[value]

// Revoking also moves the Users panel's "Sessions" count.
const refresh = () => props.self ? refreshList() : Promise.all([refreshList(), refreshNuxtData('users-summary')])
// Revoking is a plain row update through the Data API (PostgreSQL stamps the time); your own go through My account.
const dataApi = useDataApi()
const revokeRequest = (id: string) => props.self
  ? appApi.del(`/me/sessions/${id}`)
  : dataApi.patch(dataApi.resourcePath('totalbase', 'sessions', 'table', id), { data: { revoked_at: new Date().toISOString() } })

const refreshing = ref(false)
async function refreshSessions() {
  refreshing.value = true
  try {
    await refresh()
  } finally {
    refreshing.value = false
  }
}

function isRevoked(s: Session) {
  return s.revokedAt !== null
}
function isExpired(s: Session) {
  return new Date(s.expiresAt).getTime() < Date.now()
}
function statusLabel(s: Session) {
  return isRevoked(s) ? t('users.sessions.revoked') : isExpired(s) ? t('users.sessions.expired') : t('users.sessions.active')
}
function statusColor(s: Session) {
  return isRevoked(s) ? 'neutral' : isExpired(s) ? 'warning' : 'success'
}
const relative = (value: string) => formatDistanceToNow(new Date(value), { addSuffix: true, locale: ui.dateFns.value })
const { dateTime: exact } = useDateTimeFormat()

const columns = computed(() => [
  { id: 'select', header: '', meta: { class: { th: 'w-10', td: 'w-10' } } },
  ...(props.userId || props.self ? [] : [{ accessorKey: 'user', header: t('common.user') }]),
  { id: 'device', header: t('users.sessions.device') },
  { accessorKey: 'lastSeenAt', header: t('users.sessions.lastSeen') },
  { accessorKey: 'createdAt', header: t('users.sessions.signedIn') },
  { accessorKey: 'expiresAt', header: t('users.sessions.expires') },
  { id: 'status', header: t('common.status') },
  { id: 'actions', header: '' }
])

// --- Selection: kept by id across pages (the rows themselves, so a bulk
// revoke doesn't need them on screen). The admin's own session and
// revoked ones can't be selected. ---
const selectedById = ref<Record<string, Session>>({})
const selectedSessions = computed(() => Object.values(selectedById.value))
const selectable = (s: Session) => !s.current && !isRevoked(s)
function toggle(s: Session, value: boolean) {
  const rest = Object.entries(selectedById.value).filter(([id]) => id !== s.id)
  selectedById.value = Object.fromEntries(value ? [...rest, [s.id, s]] : rest)
}
const pageSelectable = computed(() => rows.value.filter(selectable))
const pageSelection = computed<boolean | 'indeterminate'>(() => {
  const count = pageSelectable.value.filter(s => selectedById.value[s.id]).length
  return count === 0 ? false : count === pageSelectable.value.length ? true : 'indeterminate'
})
function togglePage(value: boolean) {
  for (const s of pageSelectable.value) toggle(s, value)
}

const revokingId = ref<string | null>(null)
const bulkRevoking = ref(false)

// A single session - the admin's own signs them out (the "⋯" says so).
async function revoke(s: Session) {
  revokingId.value = s.id
  try {
    await revokeRequest(s.id)
    if (s.current) {
      session.clear()
      await navigateTo('/login')
      return
    }
    toast.add({ title: t('users.sessions.revokedOne'), color: 'success' })
    toggle(s, false)
    await refresh()
  } catch (err) {
    notifyError(err, t('users.sessions.revokeError'))
  } finally {
    revokingId.value = null
  }
}

async function revokeSelected() {
  const targets = selectedSessions.value.filter(selectable)
  if (targets.length === 0) return
  bulkRevoking.value = true
  let failures = 0
  for (const target of targets) {
    try {
      await revokeRequest(target.id)
    } catch {
      failures += 1
    }
  }
  bulkRevoking.value = false
  selectedById.value = {}
  await refresh()
  if (failures === 0) {
    toast.add({ title: t('users.sessions.revokedMany', targets.length), color: 'success' })
  } else {
    toast.add({ title: t('users.sessions.revokedPartial', { done: targets.length - failures, total: targets.length }), description: t('users.sessions.failed', { n: failures }), color: 'warning' })
  }
}

// My account: sign out everywhere but here, in one request.
const revokingOthers = ref(false)
async function revokeOthers() {
  revokingOthers.value = true
  try {
    await appApi.post('/me/sessions/revoke-others')
    selectedById.value = {}
    toast.add({ title: t('users.sessions.othersSignedOut'), color: 'success' })
    await refresh()
  } catch (err) {
    notifyError(err, t('users.sessions.othersError'))
  } finally {
    revokingOthers.value = false
  }
}

function actionItems(s: Session) {
  if (isRevoked(s)) return []
  return [[{
    label: s.current ? t('users.sessions.signOutThis') : t('users.sessions.revoke'),
    icon: s.current ? 'i-lucide-log-out' : 'i-lucide-ban',
    color: 'error' as const,
    onSelect: () => revoke(s)
  }]]
}
// Header: Refresh (PageHeader's "⋮" on a phone) and the bulk actions
// while rows are selected.
const headerActions = computed<HeaderAction[]>(() => [
  { label: t('users.sessions.refresh'), icon: 'i-lucide-refresh-cw', iconOnly: true, loading: refreshing.value, onSelect: refreshSessions }
])
const headerSelection = computed<HeaderSelection>(() => ({
  count: selectedSessions.value.length,
  actions: [{ label: t('users.sessions.revoke'), icon: 'i-lucide-ban', color: 'error', loading: bulkRevoking.value, onSelect: revokeSelected }],
  onClear: () => {
    selectedById.value = {}
  }
}))
</script>

<template>
  <PageShell>
    <!-- Left = acts on the selection, right = how you're viewing (search,
    refresh). In a user's tab the same controls are the toolbar's first row. -->
    <template
      v-if="header"
      #header
    >
      <PageHeader
        v-bind="header"
        :actions="headerActions"
        :selection="headerSelection"
      >
        <template #search>
          <HeaderSearch
            v-model="search"
            :placeholder="t('users.sessions.searchAll')"
            class="w-64"
          />
        </template>
      </PageHeader>
    </template>

    <template #toolbar>
      <div class="flex flex-wrap items-center gap-3">
        <span class="text-xs font-medium uppercase tracking-wide text-muted">{{ t('common.status') }}</span>
        <UFieldGroup>
          <UButton
            v-for="f in STATUS_FILTERS"
            :key="f.value"
            :label="`${f.label} ${countOf(f.value)}`"
            :color="status === f.value ? 'primary' : 'neutral'"
            :variant="status === f.value ? 'soft' : 'outline'"
            size="sm"
            @click="status = f.value"
          />
        </UFieldGroup>
        <!-- A user's tab has no PageHeader: its selection actions, search
        and refresh share this row. -->
        <template v-if="!header">
          <template v-if="selectedSessions.length > 0">
            <span class="text-sm text-muted whitespace-nowrap">{{ t('users.common.selected', { n: selectedSessions.length }) }}</span>
            <UButton
              icon="i-lucide-ban"
              :label="t('users.sessions.revoke')"
              color="error"
              variant="outline"
              size="sm"
              :loading="bulkRevoking"
              @click="revokeSelected"
            />
            <UButton
              :label="t('users.common.clearSelection')"
              color="neutral"
              variant="ghost"
              size="sm"
              @click="selectedById = {}"
            />
          </template>
          <div class="flex-1" />
          <UButton
            v-if="self"
            icon="i-lucide-log-out"
            :label="t('users.sessions.signOutOthers')"
            color="neutral"
            variant="outline"
            size="sm"
            :loading="revokingOthers"
            @click="revokeOthers"
          />
          <UInput
            v-model="search"
            :aria-label="t('users.sessions.searchOwn')"
            icon="i-lucide-search"
            :placeholder="t('users.sessions.searchOwn')"
            class="w-64"
          />
          <UTooltip :text="t('users.sessions.refresh')">
            <UButton
              :aria-label="t('users.sessions.refresh')"
              icon="i-lucide-refresh-cw"
              color="neutral"
              variant="outline"
              square
              :loading="refreshing"
              @click="refreshSessions"
            />
          </UTooltip>
        </template>
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
        :data="rows"
        :columns="columns"
        :loading="pending"
        :get-row-id="(row: Session) => row.id"
      >
        <template #empty>
          <UEmpty
            variant="naked"
            size="sm"
            icon="i-lucide-monitor-smartphone"
            :title="query ? t('users.sessions.noMatch', { query }) : t(`users.sessions.empty.${status}`)"
          />
        </template>
        <template #select-header>
          <UCheckbox
            :model-value="pageSelection"
            :disabled="pageSelectable.length === 0"
            :aria-label="t('users.common.selectPage')"
            @update:model-value="(v: boolean | 'indeterminate') => togglePage(v === true)"
          />
        </template>
        <template #select-cell="{ row }">
          <UCheckbox
            v-if="selectable(row.original)"
            :model-value="!!selectedById[row.original.id]"
            :aria-label="t('users.sessions.selectSession')"
            @update:model-value="(v: boolean | 'indeterminate') => toggle(row.original, v === true)"
          />
        </template>
        <template #user-cell="{ row }">
          <NuxtLink
            :to="`/users/${row.original.user}?section=sessions`"
            class="flex min-w-0 flex-col hover:underline"
          >
            <span class="truncate text-highlighted">{{ row.original.userName || row.original.userEmail }}</span>
            <span
              v-if="row.original.userName"
              class="truncate text-xs text-muted"
            >{{ row.original.userEmail }}</span>
          </NuxtLink>
        </template>
        <template #device-cell="{ row }">
          <div class="flex items-center gap-2">
            <UIcon
              :name="describeUserAgent(row.original.userAgent).icon"
              class="size-4 shrink-0 text-muted"
            />
            <div class="flex min-w-0 flex-col">
              <span
                class="flex items-center gap-2"
                :title="row.original.userAgent ?? undefined"
              >
                {{ describeUserAgent(row.original.userAgent, t).label }}
                <UBadge
                  v-if="row.original.current"
                  :label="t('users.sessions.thisSession')"
                  color="primary"
                  variant="subtle"
                  size="sm"
                />
              </span>
              <span class="font-mono text-xs text-muted">{{ row.original.ip ?? '—' }}</span>
            </div>
          </div>
        </template>
        <template #lastSeenAt-cell="{ row }">
          <span
            class="text-muted whitespace-nowrap"
            :title="exact(row.original.lastSeenAt)"
          >{{ relative(row.original.lastSeenAt) }}</span>
        </template>
        <template #createdAt-cell="{ row }">
          <span
            class="text-muted whitespace-nowrap"
            :title="exact(row.original.createdAt)"
          >{{ relative(row.original.createdAt) }}</span>
        </template>
        <template #expiresAt-cell="{ row }">
          <span
            class="text-muted whitespace-nowrap"
            :title="exact(row.original.expiresAt)"
          >{{ relative(row.original.expiresAt) }}</span>
        </template>
        <template #status-cell="{ row }">
          <UBadge
            :color="statusColor(row.original)"
            variant="subtle"
            size="sm"
          >
            {{ statusLabel(row.original) }}
          </UBadge>
        </template>
        <template #actions-cell="{ row }">
          <div class="flex justify-end">
            <UDropdownMenu
              v-if="actionItems(row.original).length"
              :items="actionItems(row.original)"
              :content="{ align: 'end' }"
            >
              <UButton
                icon="i-lucide-ellipsis-vertical"
                color="neutral"
                variant="ghost"
                size="xs"
                :aria-label="t('users.sessions.actions')"
                :loading="revokingId === row.original.id"
              />
            </UDropdownMenu>
          </div>
        </template>
      </UTable>
    </div>

    <template #footer>
      <TablePager
        v-model:page="page"
        v-model:page-size="prefs.pageSize"
        :total="total"
        :noun="t('users.sessions.noun')"
        :plural="t('users.sessions.nounPlural')"
        :page-size-options="[20, 50, 100, 200]"
      />
    </template>
  </PageShell>
</template>
