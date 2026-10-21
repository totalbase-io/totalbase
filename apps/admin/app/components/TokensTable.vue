<script setup lang="ts">
/**
 * Personal access tokens - the global view (pages/tokens.vue, every user's
 * tokens) and a user's own Tokens tab (pages/users/[id].vue) share this
 * component and all of its create/regenerate/revoke/delete logic, but not a
 * frame:
 * - with `userId` (a user's tab): that user's tokens in one bordered list;
 * - with `header` (global): the same rows grouped by owner - one bordered
 *   group per user (avatar, name, token count, link to their Tokens tab) -
 *   under status / access filters and a search that also matches a key
 *   prefix, with checkboxes for bulk Revoke/Delete - not paged.
 * Both draw each token with TokenRow; "⋯" carries its actions.
 * - with `self` (My account, alongside the caller's own `userId`): the
 *   same list through the self-service /api/tokens routes, which any
 *   portal user who can hold a token reaches - `planes` narrows the
 *   Access choice to the planes they can hold.
 *
 * Every token expires (UsersApisService.create, `api_keys.default_ttl_days`
 * by default): the expiry is chosen at creation and shown on every row,
 * amber within `api_keys.rotation_warning_days`, red once past; Regenerate
 * renews it with a new secret. A new or regenerated secret is shown once,
 * inline above the tokens, until dismissed.
 */
import type { UserApiToken, UserApiTokenSecret } from '~/types/security'

const props = defineProps<{
  userId?: string
  /** My account: the caller's own tokens through /api/tokens (the self-service routes), not /admin/api/tokens. */
  self?: boolean
  /** The planes offered on create (My account: only what the caller can hold). Default both. */
  planes?: Array<'API' | 'ADMIN'>
  /** The global page's PageHeader (title/description/icon) - the grouped layout. */
  header?: { title: string, description?: string, icon?: string }
}>()

// My account reaches the self-service /api/tokens routes (same paths
// and bodies below /tokens), everything else the Admin API's oversight -
// except listing, revoking and deleting, plain rows of tokens read
// and written through the Data API (Security.md §10;
// PostgreSQL keeps such a write to a rename, a deactivation or a
// revocation). Issuing and rotating stay on the routes.
const adminApi = useAdminApi()
const dataApi = useDataApi()
const apisPath = dataApi.resourcePath('totalbase', 'tokens')
function tokenFromRow(row: Record<string, unknown>): UserApiToken {
  return {
    id: row.id as string,
    user: row.user as string,
    name: row.name as string,
    description: (row.description ?? null) as string | null,
    plane: row.plane as UserApiToken['plane'],
    keyPrefix: row.key_prefix as string,
    active: row.active === true,
    expiresAt: (row.expires_at ?? null) as string | null,
    lastUsedAt: (row.last_used_at ?? null) as string | null,
    rotatedAt: (row.rotated_at ?? null) as string | null,
    revokedAt: (row.revoked_at ?? null) as string | null,
    createdAt: row.created_at as string
  }
}
const listTokens = async (): Promise<UserApiToken[]> => props.self
  ? (await dataApi.get<UserApiToken[]>('/tokens')).data
  : (await dataApi.getAll<Record<string, unknown>>(apisPath, { order_by: '-created_at', ...(props.userId && { 'where[user][_eq]': props.userId }) })).map(tokenFromRow)
const revokeToken = (id: string) => props.self
  ? dataApi.post(`/tokens/${id}/revoke`)
  : dataApi.patch(`${apisPath}/${id}`, { data: { active: false, revoked_at: new Date().toISOString() } })
const deleteToken = (id: string) => props.self ? dataApi.del(`/tokens/${id}`) : dataApi.del(`${apisPath}/${id}`)
const api = {
  post<T>(path: string, body?: unknown) {
    return props.self ? dataApi.post<T>(path, body) : adminApi.post<T>(path, body)
  }
}
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()

// A user's tab asks the server for that user's tokens only (?user=). The
// global view's User column resolves owners through the shared user
// directory - only the ids on screen, in one batch - never the full list.
const { data: tokens, pending, error, refresh: refreshList } = await useAsyncData(
  props.self ? 'tokens-me' : props.userId ? `tokens-${props.userId}` : 'tokens',
  listTokens,
  { default: () => [] }
)
// Every change also moves the Users panel's "API tokens" count.
const refresh = () => props.self ? refreshList() : Promise.all([refreshList(), refreshNuxtData('users-summary')])

const { defaultTtlDays, tokenState, usable } = useTokenStatus()

const directory = useUserDirectory()
watch(tokens, (list) => {
  if (!props.userId) directory.ensure((list ?? []).map(t => t.user))
}, { immediate: true })

function userLabel(userId: string) {
  return directory.email(userId) ?? directory.label(userId)
}

const refreshing = ref(false)
async function refreshTokens() {
  refreshing.value = true
  try {
    await refresh()
  } finally {
    refreshing.value = false
  }
}

// --- The user's list: tokens that still work first, newest first
// within that (the server already orders by created_at DESC). ---
const listed = computed(() => [...(tokens.value ?? [])].sort((a, b) => Number(usable(b)) - Number(usable(a))))

// --- The global page: status / access filters (in the URL, so a view
// is shareable) and search, all client-side - the whole list is already
// loaded. ---
const route = useRoute()
const router = useRouter()

type StatusFilter = 'all' | TokenState
type AccessFilter = 'all' | 'API' | 'ADMIN'
const STATUS_FILTERS = computed<Array<{ value: StatusFilter, label: string }>>(() => [
  { value: 'all', label: t('common.all') },
  { value: 'active', label: t('users.tokenStatus.state.active') },
  { value: 'expiring', label: t('users.tokenStatus.state.expiring') },
  { value: 'expired', label: t('users.tokenStatus.state.expired') },
  { value: 'revoked', label: t('users.tokenStatus.state.revoked') }
])
const ACCESS_FILTERS = computed<Array<{ value: AccessFilter, label: string }>>(() => [
  { value: 'all', label: t('common.all') },
  { value: 'API', label: t('users.tokens.dataApi') },
  { value: 'ADMIN', label: t('users.tokens.adminApi') }
])
function queryFilter<T extends string>(key: string, allowed: Array<{ value: T }>) {
  return computed<T>({
    get: () => (allowed.find(f => f.value === route.query[key])?.value ?? 'all') as T,
    set: value => router.replace({ query: { ...route.query, [key]: value === 'all' ? undefined : value } })
  })
}
const statusFilter = queryFilter('status', STATUS_FILTERS.value)
const accessFilter = queryFilter('access', ACCESS_FILTERS.value)

const search = ref('')
const matchesStatus = (t: UserApiToken, status: StatusFilter) => status === 'all' || tokenState(t) === status
const matchesAccess = (t: UserApiToken, access: AccessFilter) => access === 'all' || t.plane === access

// Faceted counts: each group counts under the other group's filter, so
// its alternatives stay visible.
const statusCounts = computed(() => {
  const inAccess = (tokens.value ?? []).filter(t => matchesAccess(t, accessFilter.value))
  return Object.fromEntries(STATUS_FILTERS.value.map(f => [f.value, inAccess.filter(t => matchesStatus(t, f.value)).length]))
})
const accessCounts = computed(() => {
  const inStatus = (tokens.value ?? []).filter(t => matchesStatus(t, statusFilter.value))
  return Object.fromEntries(ACCESS_FILTERS.value.map(f => [f.value, inStatus.filter(t => matchesAccess(t, f.value)).length]))
})
const hasFilters = computed(() => statusFilter.value !== 'all' || accessFilter.value !== 'all' || !!search.value.trim())
function clearFilters() {
  search.value = ''
  router.replace({ query: { ...route.query, status: undefined, access: undefined } })
}

// Name, description, owner - or the key prefix: a leaked secret is found
// by pasting its first characters (tb_… or the whole thing).
const filtered = computed(() => {
  const term = search.value.trim().replace(/…$/, '').toLowerCase()
  return (tokens.value ?? []).filter(t =>
    matchesStatus(t, statusFilter.value)
    && matchesAccess(t, accessFilter.value)
    && (!term
      || t.name.toLowerCase().includes(term)
      || (t.description ?? '').toLowerCase().includes(term)
      || userLabel(t.user).toLowerCase().includes(term)
      || (term.startsWith('tb_') && (term.startsWith(t.keyPrefix.toLowerCase()) || t.keyPrefix.toLowerCase().startsWith(term))))
  )
})

// One group per owner, by name; a user's working tokens first, newest
// first within that (the server orders by created_at DESC). No pages:
// the whole list is already loaded, tokens are few, and the filters and
// search are how one is found - pages would only get in the way of
// selecting, say, every expired token at once.
const groups = computed(() => {
  const byUser = new Map<string, UserApiToken[]>()
  for (const token of filtered.value) byUser.set(token.user, [...(byUser.get(token.user) ?? []), token])
  return [...byUser.entries()]
    .map(([user, list]) => ({ user, tokens: list.sort((a, b) => Number(usable(b)) - Number(usable(a))) }))
    .sort((a, b) => directory.label(a.user).localeCompare(directory.label(b.user)))
})

// Per-token "⋯" menu - the only place single-token actions live.
function actionItems(token: UserApiToken) {
  const state = tokenState(token)
  return [
    [
      { label: t('users.tokens.regenerateEllipsis'), icon: 'i-lucide-refresh-cw', disabled: state === 'revoked', onSelect: () => { regenTarget.value = token } },
      { label: t('users.sessions.revoke'), icon: 'i-lucide-ban', disabled: state === 'revoked', onSelect: () => revokeTokens([token]) }
    ],
    [
      { label: t('common.deleteEllipsis'), icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => openDrop([{ id: token.id, name: token.name }]) }
    ]
  ]
}

// --- Selection (global page) - lets the header switch to bulk
// Revoke/Delete once something's checked. Keyed by id, so it survives a
// filter change; only tokens the filters still show count. ---
const rowSelection = ref<Record<string, boolean>>({})
const selectedTokens = computed(() => filtered.value.filter(t => rowSelection.value[t.id]))

function setSelected(ids: string[], value: boolean) {
  const changing = new Set(ids)
  rowSelection.value = Object.fromEntries([
    ...Object.entries(rowSelection.value).filter(([id]) => !changing.has(id)),
    ...(value ? ids.map(id => [id, true] as const) : [])
  ])
}
/** A group's header checkbox: all, some ('indeterminate') or none of its tokens. */
function groupSelection(list: UserApiToken[]): boolean | 'indeterminate' {
  const count = list.filter(t => rowSelection.value[t.id]).length
  return count === 0 ? false : count === list.length ? true : 'indeterminate'
}

// A secret is only ever returned once - right after create or regenerate -
// and never stored. The banner above the tokens is the only place it's
// ever shown; it stays until dismissed.
const revealed = ref<{ name: string, key: string, rotated: boolean } | null>(null)

// --- Create - AppDrawer's shared bottom-drawer chrome. ---
const isCreateOpen = ref(false)
const newUserId = ref('')
const newName = ref('')
const newDescription = ref('')
const newPlane = ref<'API' | 'ADMIN'>('API')
const newTtlDays = ref<number | null>(null)
/** Remounts TokenExpiryField per opening, so it starts back at the default. */
const formKey = ref(0)
const creating = ref(false)

const planeItems = computed(() => [{ label: t('users.tokens.dataApi'), value: 'API' as const }, { label: t('users.tokens.adminApi'), value: 'ADMIN' as const }]
  .filter(item => !props.planes || props.planes.includes(item.value)))

const canCreate = computed(() => !!newUserId.value && !!newName.value.trim() && newTtlDays.value !== null)

const emptyState = computed(() => hasFilters.value
  ? { title: t('users.tokens.noMatch'), actions: [{ label: t('users.tokens.clearFilters'), color: 'neutral' as const, variant: 'link' as const, onClick: clearFilters }] }
  : {
      title: t('users.tokens.emptyTitle'),
      description: t('users.tokens.emptyDescription'),
      actions: [{ label: t('users.tokens.newToken'), icon: 'i-lucide-plus', onClick: openCreate }]
    })
function openCreate() {
  newUserId.value = props.userId ?? ''
  newName.value = ''
  newDescription.value = ''
  newPlane.value = planeItems.value[0]?.value ?? 'API'
  formKey.value += 1
  isCreateOpen.value = true
}

async function createToken() {
  if (!canCreate.value) return
  creating.value = true
  try {
    const { data } = await api.post<UserApiToken & UserApiTokenSecret>('/tokens', {
      data: {
        ...(!props.self && { userId: newUserId.value }),
        name: newName.value.trim(),
        description: newDescription.value.trim() || null,
        plane: newPlane.value,
        ttlDays: newTtlDays.value
      }
    })
    isCreateOpen.value = false
    await refresh()
    revealed.value = { name: data.name, key: data.key, rotated: false }
  } catch (err) {
    notifyError(err, t('users.tokens.createError'))
  } finally {
    creating.value = false
  }
}

// --- Regenerate (GitHub's model): a new secret and a new expiry for the
// same token - name, access and audit history stay. Works on an expired
// token (renewing it is the usual reason), never on a revoked one. A
// modal, not a popover: it's launched from a "⋯" menu item, and it cuts
// off whatever uses the current secret. Never batched - each one reveals
// its own secret, and the banner holds one at a time. ---
const regenTarget = ref<UserApiToken | null>(null)
const isRegenOpen = computed({
  get: () => regenTarget.value !== null,
  set: (open: boolean) => { if (!open) regenTarget.value = null }
})
const regenTtlDays = ref<number | null>(null)
// Stripe's "roll key": the old secret can keep working a while, so whatever
// uses it can switch without downtime (Security.md §3.3).
const GRACE_OPTIONS = computed(() => [
  { label: t('users.tokens.grace.now'), value: 0 },
  { label: t('users.tokens.grace.hour'), value: 1 },
  { label: t('users.tokens.grace.day'), value: 24 },
  { label: t('users.tokens.grace.week'), value: 168 }
])
const regenGraceHours = ref(0)
watch(regenTarget, () => {
  regenGraceHours.value = 0
})
const regenerating = ref(false)

async function regenerateToken() {
  const token = regenTarget.value
  if (!token || regenTtlDays.value === null) return
  regenerating.value = true
  try {
    const { data } = await api.post<UserApiToken & UserApiTokenSecret>(`/tokens/${token.id}/rotate`, { data: { ttlDays: regenTtlDays.value, graceHours: regenGraceHours.value } })
    regenTarget.value = null
    await refresh()
    revealed.value = { name: token.name, key: data.key, rotated: true }
  } catch (err) {
    notifyError(err, t('users.tokens.regenerateError'))
  } finally {
    regenerating.value = false
  }
}

// A single token's "Revoke" and the grid's bulk Revoke (only active
// tokens are actually revoked - a revoked one is silently skipped).
const revoking = ref(false)
async function revokeTokens(targets: UserApiToken[]) {
  const active = targets.filter(t => t.active)
  if (active.length === 0) return
  revoking.value = true
  let failures = 0
  for (const target of active) {
    try {
      await revokeToken(target.id)
    } catch {
      failures += 1
    }
  }
  revoking.value = false
  rowSelection.value = {}
  await refresh()
  if (failures === 0) {
    toast.add({ title: t('users.tokens.revoked', active.length), color: 'success' })
  } else {
    toast.add({
      title: t('users.sessions.revokedPartial', { done: active.length - failures, total: active.length }),
      description: t('users.sessions.failed', { n: failures }),
      color: 'warning'
    })
  }
}

// --- Delete confirmation - a checkbox before the destructive button
// enables, even for one token (AGENTS.md §25 "Delete confirmation
// checkbox"). A token's "Delete…" and the grid's bulk Delete both land
// here (openDrop takes a list either way). ---
const dropTargets = ref<Array<{ id: string, name: string }>>([])
const isDeleteOpen = computed({
  get: () => dropTargets.value.length > 0,
  set: (open: boolean) => { if (!open) dropTargets.value = [] }
})
const dropConfirmed = ref(false)
const deleting = ref(false)
const deleteModalTitle = computed(() =>
  t('users.tokens.deleteTitle', dropTargets.value.length)
)

function openDrop(targets: Array<{ id: string, name: string }>) {
  dropConfirmed.value = false
  dropTargets.value = targets
}

// Header: Refresh (PageHeader's "⋮" on a phone) and the bulk actions
// while tokens are selected.
const headerActions = computed<HeaderAction[]>(() => [
  { label: t('users.tokens.refresh'), icon: 'i-lucide-refresh-cw', iconOnly: true, loading: refreshing.value, onSelect: refreshTokens }
])
const headerSelection = computed<HeaderSelection>(() => ({
  count: selectedTokens.value.length,
  actions: [
    { label: t('users.sessions.revoke'), icon: 'i-lucide-ban', color: 'warning', disabled: !selectedTokens.value.some(t => t.active), loading: revoking.value, onSelect: () => revokeTokens(selectedTokens.value) },
    { label: t('common.delete'), icon: 'i-lucide-trash-2', color: 'error', onSelect: () => openDrop(selectedTokens.value.map(t => ({ id: t.id, name: t.name }))) }
  ],
  onClear: () => {
    rowSelection.value = {}
  }
}))

async function confirmDrop() {
  const targets = dropTargets.value
  deleting.value = true
  let failures = 0
  for (const target of targets) {
    try {
      await deleteToken(target.id)
    } catch {
      failures += 1
    }
  }
  deleting.value = false
  dropTargets.value = []
  rowSelection.value = {}
  await refresh()
  if (failures === 0) {
    toast.add({ title: t('users.tokens.deleted', targets.length), color: 'success' })
  } else {
    toast.add({
      title: t('users.tokens.deletedPartial', { done: targets.length - failures, total: targets.length }),
      description: t('users.sessions.failed', { n: failures }),
      color: 'warning'
    })
  }
}

async function copySecret() {
  if (!revealed.value) return
  await navigator.clipboard.writeText(revealed.value.key)
  toast.add({ title: t('users.tokens.copied'), color: 'success' })
}
</script>

<template>
  <PageShell>
    <!-- Global grid: the controls sit in the PageHeader. Left = acts on the
    set (new token / bulk actions once something's checked), right = how
    you're viewing it (search, refresh). -->
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
            :placeholder="t('users.tokens.search')"
            class="w-64"
          />
        </template>
        <UButton
          v-if="selectedTokens.length === 0"
          icon="i-lucide-plus"
          :label="t('users.tokens.newToken')"
          @click="openCreate"
        />
      </PageHeader>
    </template>

    <!-- Global grid: status and access filters, with counts. A user's
    list: what tokens are, then New token. -->
    <template #toolbar>
      <div
        v-if="header"
        class="flex flex-wrap items-center gap-x-6 gap-y-2"
      >
        <div class="flex items-center gap-2">
          <span class="text-xs font-medium uppercase tracking-wide text-muted">{{ t('common.status') }}</span>
          <UFieldGroup>
            <UButton
              v-for="f in STATUS_FILTERS"
              :key="f.value"
              :label="`${f.label} ${statusCounts[f.value]}`"
              :color="statusFilter === f.value ? 'primary' : 'neutral'"
              :variant="statusFilter === f.value ? 'soft' : 'outline'"
              size="sm"
              @click="statusFilter = f.value"
            />
          </UFieldGroup>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-xs font-medium uppercase tracking-wide text-muted">{{ t('users.roleForm.access') }}</span>
          <UFieldGroup>
            <UButton
              v-for="f in ACCESS_FILTERS"
              :key="f.value"
              :label="`${f.label} ${accessCounts[f.value]}`"
              :color="accessFilter === f.value ? 'primary' : 'neutral'"
              :variant="accessFilter === f.value ? 'soft' : 'outline'"
              size="sm"
              @click="accessFilter = f.value"
            />
          </UFieldGroup>
        </div>
      </div>
      <div
        v-else
        class="flex items-center gap-3"
      >
        <p class="flex-1 text-sm text-muted">
          {{ self ? t('users.tokens.introSelf') : t('users.tokens.introUser') }}
        </p>
        <UTooltip :text="t('users.tokens.refresh')">
          <UButton
            :aria-label="t('users.tokens.refresh')"
            icon="i-lucide-refresh-cw"
            color="neutral"
            variant="outline"
            square
            :loading="refreshing"
            @click="refreshTokens"
          />
        </UTooltip>
        <UButton
          icon="i-lucide-plus"
          :label="t('users.tokens.newToken')"
          @click="openCreate"
        />
      </div>
    </template>

    <div class="flex flex-col gap-4">
      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        :title="error.message"
      />

      <!-- The one time a secret is visible. -->
      <div
        v-if="revealed"
        class="flex flex-col gap-3 rounded-lg border border-success/40 bg-success/10 p-4"
      >
        <div class="flex items-start gap-2">
          <UIcon
            name="i-lucide-circle-check"
            class="mt-0.5 size-5 shrink-0 text-success"
          />
          <div class="flex-1 text-sm">
            <p class="font-medium text-highlighted">
              {{ revealed.rotated ? t('users.tokens.regenerated', { name: revealed.name }) : t('users.tokens.created', { name: revealed.name }) }}
            </p>
            <p class="text-muted">
              {{ revealed.rotated ? t('users.tokens.copyNowRotated') : t('users.tokens.copyNow') }}
            </p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <code class="flex-1 rounded-md border border-default bg-default px-3 py-2 text-xs break-all">{{ revealed.key }}</code>
          <UButton
            icon="i-lucide-copy"
            :label="t('common.copy')"
            color="neutral"
            variant="outline"
            @click="copySecret"
          />
          <UButton
            :label="t('common.done')"
            color="neutral"
            variant="ghost"
            @click="revealed = null"
          />
        </div>
      </div>

      <!-- A user's tokens: one bordered list. -->
      <template v-if="!header">
        <div
          v-if="listed.length"
          class="flex flex-col divide-y divide-default rounded-lg border border-default bg-default"
        >
          <TokenRow
            v-for="token in listed"
            :key="token.id"
            :token="token"
            :actions="actionItems(token)"
          />
        </div>
        <div
          v-else-if="!pending"
          class="flex flex-col items-center gap-1 rounded-lg border border-dashed border-default px-4 py-10 text-center"
        >
          <UIcon
            name="i-lucide-key-round"
            class="size-6 text-dimmed"
          />
          <p class="text-sm font-medium text-highlighted">
            {{ t('users.tokens.noTokens') }}
          </p>
          <p class="text-sm text-muted">
            {{ self ? t('users.tokens.noneSelf') : t('users.tokens.noneUser') }}
          </p>
        </div>
      </template>

      <!-- Every user's tokens: one group per owner. -->
      <template v-else>
        <div
          v-for="group in groups"
          :key="group.user"
          class="overflow-hidden rounded-lg border border-default bg-default"
        >
          <div class="flex items-center gap-3 border-b border-default bg-elevated/50 px-4 py-2.5">
            <UCheckbox
              :model-value="groupSelection(group.tokens)"
              :aria-label="t('users.tokens.selectGroup', { user: directory.label(group.user) })"
              @update:model-value="(v: boolean | 'indeterminate') => setSelected(group.tokens.map(t => t.id), v === true)"
            />
            <UAvatar
              :src="directory.avatar(group.user) ?? undefined"
              :alt="directory.label(group.user)"
              size="sm"
            />
            <NuxtLink
              :to="`/users/${group.user}?section=tokens`"
              class="flex min-w-0 flex-1 flex-col hover:underline"
            >
              <span class="truncate text-sm font-medium text-highlighted">{{ directory.label(group.user) }}</span>
              <span
                v-if="directory.email(group.user) && directory.email(group.user) !== directory.label(group.user)"
                class="truncate text-xs text-muted"
              >{{ directory.email(group.user) }}</span>
            </NuxtLink>
            <span class="shrink-0 text-xs text-muted">{{ t('users.tokens.tokenCount', group.tokens.length) }}</span>
          </div>
          <div class="flex flex-col divide-y divide-default">
            <TokenRow
              v-for="token in group.tokens"
              :key="token.id"
              :token="token"
              :actions="actionItems(token)"
              selectable
              :selected="!!rowSelection[token.id]"
              @update:selected="(v: boolean) => setSelected([token.id], v)"
            />
          </div>
        </div>

        <UEmpty
          v-if="!pending && groups.length === 0"
          icon="i-lucide-key-round"
          v-bind="emptyState"
        />
      </template>
    </div>

    <template
      v-if="header"
      #footer
    >
      <span class="text-sm text-muted">
        {{ t('users.tokens.userCount', groups.length) }} · {{ t('users.tokens.tokenCount', filtered.length) }}
      </span>
    </template>

    <AppDrawer
      v-model:open="isCreateOpen"
      :title="t('users.tokens.newToken')"
      :description="t('users.tokens.newTokenDescription')"
      size="sm"
    >
      <form
        id="new-token-form"
        class="flex-1 min-h-0 overflow-y-auto flex flex-col gap-4"
        @submit.prevent="createToken"
      >
        <UFormField
          v-if="!userId"
          :label="t('common.user')"
          required
          :description="t('users.tokens.userHelp')"
        >
          <UserPicker
            v-model="newUserId"
            :aria-label="t('common.user')"
          />
        </UFormField>
        <UFormField
          :label="t('common.name')"
          required
          :description="self ? t('users.tokens.nameHelpSelf') : t('users.tokens.nameHelpUser')"
        >
          <UInput
            v-model="newName"
            maxlength="32"
            autocomplete="off"
            class="w-full"
          />
        </UFormField>
        <UFormField
          :label="t('common.description')"
          :description="t('users.tokens.descriptionHelp')"
        >
          <UTextarea
            v-model="newDescription"
            :rows="2"
            maxlength="128"
            class="w-full"
          />
        </UFormField>
        <UFormField
          :label="t('users.roleForm.access')"
          :description="t('users.tokens.accessHelp')"
        >
          <USelect
            v-model="newPlane"
            :items="planeItems"
            class="w-full"
          />
        </UFormField>
        <TokenExpiryField
          :key="formKey"
          v-model="newTtlDays"
          :default-days="defaultTtlDays"
        />
      </form>

      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="ghost"
            :disabled="creating"
            @click="isCreateOpen = false"
          />
          <UButton
            type="submit"
            form="new-token-form"
            :label="t('users.tokens.createToken')"
            :loading="creating"
            :disabled="!canCreate"
          />
        </div>
      </template>
    </AppDrawer>

    <UModal
      v-model:open="isRegenOpen"
      :title="t('users.tokens.regenerateTitle', { name: regenTarget?.name ?? '' })"
      :description="t('users.tokens.regenerateDescription')"
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <UAlert
            v-if="regenGraceHours === 0"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :title="t('users.tokens.stopsNowTitle')"
            :description="t('users.tokens.stopsNowDescription')"
          />
          <TokenExpiryField
            v-if="regenTarget"
            v-model="regenTtlDays"
            :default-days="defaultTtlDays"
          />
          <UFormField
            :label="t('users.tokens.graceLabel')"
            :description="t('users.tokens.graceHelp')"
          >
            <USelect
              v-model="regenGraceHours"
              :items="GRACE_OPTIONS"
              class="w-48"
            />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="ghost"
            :disabled="regenerating"
            @click="regenTarget = null"
          />
          <UButton
            :label="t('users.tokens.regenerate')"
            icon="i-lucide-refresh-cw"
            :loading="regenerating"
            :disabled="regenTtlDays === null"
            @click="regenerateToken"
          />
        </div>
      </template>
    </UModal>

    <UModal
      v-model:open="isDeleteOpen"
      :title="deleteModalTitle"
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <p class="text-sm text-muted">
            {{ t('users.tokens.deleteBody') }}
          </p>
          <ul class="flex flex-col gap-1 max-h-48 overflow-y-auto border border-default rounded-lg p-2">
            <li
              v-for="target in dropTargets"
              :key="target.id"
              class="text-sm truncate"
            >
              {{ target.name }}
            </li>
          </ul>
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
                :disabled="deleting"
                @click="dropTargets = []"
              />
              <UButton
                :label="t('common.delete')"
                color="error"
                :disabled="!dropConfirmed"
                :loading="deleting"
                @click="confirmDrop"
              />
            </div>
          </div>
        </div>
      </template>
    </UModal>
  </PageShell>
</template>
