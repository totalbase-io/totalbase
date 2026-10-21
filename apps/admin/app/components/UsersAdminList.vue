<script setup lang="ts">
/**
 * The Users table. Filters come from the route query, set by the Users
 * panel (UsersPanel.vue): `?status=ACTIVE|INVITED|INACTIVE` and
 * `?role=<id>`. New user / Invite live in that panel too; a row opens the
 * user's own page (pages/users/[id].vue) - no detail slideover.
 */
import { USER_STATUS_META, isSystemUser, userStatus, type AdminUserListItem, type UserStatus } from '~/types/security'
// Absolute dates/times in the user's zone and format (My account > Preferences).
const dates = useDateTimeFormat()

const api = useAdminApi()
const dataApi = useDataApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()
const route = useRoute()
const router = useRouter()

const { data: roles } = await useRoles()
const roleById = computed(() => new Map((roles.value ?? []).map(r => [r.id, r])))

const statusFilter = computed(() => {
  const value = route.query.status
  return typeof value === 'string' && value in USER_STATUS_META ? value as UserStatus : undefined
})
const roleFilter = computed(() => typeof route.query.role === 'string' ? route.query.role : undefined)
/** Filters by a column the project added - `?extra[<column>]=<value>`, as the Users panel sets them. */
const extraFilters = computed(() => Object.fromEntries(Object.entries(route.query).filter(([key, value]) => key.startsWith('extra[') && typeof value === 'string')) as Record<string, string>)

const headerTitle = computed(() => {
  if (statusFilter.value) return t(`users.usersList.titleByStatus.${statusFilter.value}`)
  if (roleFilter.value) return roleById.value.get(roleFilter.value)?.name ?? t('common.users')
  return t('common.users')
})
const headerDescription = computed(() => {
  if (statusFilter.value === 'INVITED') return t('users.usersList.descriptionInvited')
  if (statusFilter.value === 'INACTIVE') return t('users.usersList.descriptionInactive')
  if (roleFilter.value) return t('users.usersList.descriptionRole')
  return t('users.usersList.description')
})

const refreshing = ref(false)
async function refreshUsers() {
  refreshing.value = true
  try {
    await refreshUsersData()
  } finally {
    refreshing.value = false
  }
}

// --- Server-side page: search (debounced), status/role (from the panel,
// via the route query) and paging all go to GET /users?limit=..., which
// filters and counts in PostgreSQL - the table only ever holds one page. ---
const search = ref('')
const debouncedSearch = useDebouncedRef(() => search.value.trim())

const prefs = usePagePreferences('users', { pageSize: 10 })
const page = ref(1)

const { data: pageData, pending, error } = await useAsyncData(
  'users-page',
  () => api.get<AdminUserListItem[]>('/users', {
    limit: prefs.pageSize,
    offset: (page.value - 1) * prefs.pageSize,
    ...(debouncedSearch.value && { q: debouncedSearch.value }),
    ...(statusFilter.value && { status: statusFilter.value }),
    ...(roleFilter.value && { role: roleFilter.value }),
    ...extraFilters.value
  }).then(r => ({ users: r.data, total: r.meta?.total ?? r.data.length })),
  {
    default: () => ({ users: [] as AdminUserListItem[], total: 0 }),
    watch: [page, () => prefs.pageSize, debouncedSearch, statusFilter, roleFilter, extraFilters]
  }
)
const rows = computed(() => pageData.value?.users ?? [])
const total = computed(() => pageData.value?.total ?? 0)

watch([debouncedSearch, statusFilter, roleFilter, () => prefs.pageSize], () => {
  page.value = 1
  rowSelection.value = {}
})
// A delete can empty the last page - step back instead of showing none.
watch(total, (count) => {
  const pageCount = Math.max(1, Math.ceil(count / prefs.pageSize))
  if (page.value > pageCount) page.value = pageCount
})

// --- The columns the project added to users: a column each, and a Filter by those with options. ---
const { data: extraColumns } = useAsyncData('user-extra-columns', () => useUserExtraColumns().load(), { default: () => [] })
const filterColumns = computed(() => extraColumns.value.filter(c => c.kind === 'options' && (c.options?.length ?? 0) > 0))
const extraKey = (column: string) => `extra[${column}]`
/** An option's label - a foreign key's row by its presentation, a CHECK value's label; '' is no value. */
function optionLabel(column: string, value: string): string {
  const meta = extraColumns.value.find(c => c.name === column)
  if (value === '') return t('users.usersList.noValue', { column: meta?.label ?? column })
  return meta?.options?.find(o => o.value === value)?.label ?? value
}
function setExtraFilter(column: string, value: string | undefined) {
  const key = extraKey(column)
  const query = Object.fromEntries(Object.entries(route.query).filter(([k]) => k !== key))
  void router.replace({ query: value === undefined ? query : { ...query, [key]: value } })
}
const activeExtraFilters = computed(() => filterColumns.value
  .filter(c => typeof route.query[extraKey(c.name)] === 'string')
  .map(c => ({ column: c.name, label: c.label, value: route.query[extraKey(c.name)] as string })))
/** The page's rows' values of those columns - read through the Data API, as any column. */
const { data: extraValues } = useAsyncData('users-page-extra', async () => {
  const ids = rows.value.map(u => u.id)
  if (!extraColumns.value.length || !ids.length) return {} as Record<string, Record<string, unknown>>
  const found = await useDataApi().get<Record<string, unknown>[]>(useDataApi().resourcePath('totalbase', 'users'), {
    'fields': ['id', ...extraColumns.value.map(c => c.name)].join(','),
    'where[id][_in]': ids.join(','),
    'limit': ids.length
  })
  return Object.fromEntries(found.data.map(r => [String(r.id), r]))
}, { default: () => ({} as Record<string, Record<string, unknown>>), watch: [rows, extraColumns] })
function extraCell(userId: string, column: string): string {
  const meta = extraColumns.value.find(c => c.name === column)
  const value = extraValues.value[userId]?.[column]
  if (value === null || value === undefined || value === '') return meta?.emptyText ?? '—'
  return meta?.kind === 'options' ? optionLabel(column, String(value)) : typeof value === 'object' ? JSON.stringify(value) : String(value)
}

const columns = computed(() => [
  { id: 'select', header: '', meta: { class: { th: 'w-10', td: 'w-10' } } },
  { accessorKey: 'name', header: t('common.user') },
  { accessorKey: 'roles', header: t('common.roles') },
  ...extraColumns.value.map(c => ({ id: `extra:${c.name}`, header: c.label, cell: ({ row }: { row: { original: AdminUserListItem } }) => extraCell(row.original.id, c.name) })),
  { id: 'status', header: t('common.status') },
  { accessorKey: 'lastLoginAt', header: t('users.userEditor.signIn.lastSignIn') },
  { id: 'actions', header: '' }
])

const MAX_ROLE_BADGES = 3

function formatDate(value: string | null) {
  return value ? dates.dateTime(value) : '—'
}

// --- Row actions - the two things done most often from the list, without
// opening the user's page.
const togglingRowId = ref<string | null>(null)
async function toggleActiveRow(user: AdminUserListItem, next: boolean) {
  togglingRowId.value = user.id
  try {
    await dataApi.patch(dataApi.resourcePath('totalbase', 'users', 'table', user.id), { data: { active: next } })
    await refreshUsersData()
  } catch (err) {
    notifyError(err, t('users.userEditor.updateError'))
  } finally {
    togglingRowId.value = null
  }
}

function actionItems(user: AdminUserListItem) {
  const undeletable = user.owner || isSystemUser(user)
  return [
    [
      { label: t('common.open'), icon: 'i-lucide-arrow-up-right', onSelect: () => navigateTo(`/users/${user.id}`) }
    ],
    [
      user.active
        ? { label: t('users.roleEditor.deactivate'), icon: 'i-lucide-user-x', disabled: undeletable, onSelect: () => toggleActiveRow(user, false) }
        : { label: t('users.roleEditor.activate'), icon: 'i-lucide-user-check', onSelect: () => toggleActiveRow(user, true) },
      { label: t('common.delete'), icon: 'i-lucide-trash-2', color: 'error' as const, disabled: undeletable, onSelect: () => openDrop([user]) }
    ]
  ]
}

// --- Row selection - the toolbar switches to bulk delete once something's
// checked. Keyed by user id via get-row-id so selection survives
// pagination. The instance owner can still be checked here - the server
// refuses to delete it and that surfaces through the failures toast.
const rowSelection = ref<Record<string, boolean>>({})
const selectedUsers = computed(() => rows.value.filter(u => rowSelection.value[u.id]))

// --- Delete - one row's action and the toolbar's bulk Delete both land
// here (a single row is just a one-element list). ---
const dropTargets = ref<AdminUserListItem[]>([])
const isDeleteOpen = computed({
  get: () => dropTargets.value.length > 0,
  set: (open: boolean) => { if (!open) dropTargets.value = [] }
})
const dropConfirmed = ref(false)
const deleting = ref(false)
const deleteModalTitle = computed(() =>
  t('users.usersList.deleteTitle', dropTargets.value.length)
)

function openDrop(targets: AdminUserListItem[]) {
  dropConfirmed.value = false
  dropTargets.value = targets
}

async function confirmDrop() {
  const targets = dropTargets.value
  deleting.value = true
  let failures = 0
  for (const target of targets) {
    try {
      await api.del(`/users/${target.id}`)
    } catch {
      failures += 1
    }
  }
  deleting.value = false
  dropTargets.value = []
  rowSelection.value = {}
  await refreshUsersData()
  if (failures === 0) {
    toast.add({ title: t('users.usersList.deleted', targets.length), color: 'success' })
  } else {
    toast.add({
      title: t('users.tokens.deletedPartial', { done: targets.length - failures, total: targets.length }),
      description: t('users.usersList.deleteFailed', { n: failures }),
      color: 'warning'
    })
  }
}
// --- Bulk role membership and deactivation (Security.md §9.4):
// one Data API request each - one transaction, an audit row per change. ---
const rolesApi = useRolesApi()
const roleAction = ref<'add' | 'remove' | null>(null)
/** Who the action applies to - taken when it's chosen, like Delete's targets (the selection may change behind the modal). */
const roleTargets = ref<AdminUserListItem[]>([])
function openRoleAction(action: 'add' | 'remove') {
  roleTargets.value = selectedUsers.value
  roleAction.value = action
}
const roleActionOpen = computed({
  get: () => roleAction.value !== null,
  set: (open: boolean) => { if (!open) roleAction.value = null }
})
const bulkBusy = ref(false)
async function applyRole(roleId: string) {
  const userIds = roleTargets.value.map(u => u.id)
  const adding = roleAction.value === 'add'
  bulkBusy.value = true
  try {
    if (adding) await rolesApi.addMembers(roleId, userIds)
    else await rolesApi.removeMembers(roleId, userIds)
    toast.add({ title: adding ? t('users.usersList.addedToRole', { n: userIds.length }) : t('users.usersList.removedFromRole', { n: userIds.length }), color: 'success' })
    roleAction.value = null
    rowSelection.value = {}
    await refreshUsersData()
  } catch (err) {
    notifyError(err, t('users.usersList.roleError'))
  } finally {
    bulkBusy.value = false
  }
}
/** The instance owner and system users are never deactivated - left out, and said so. */
async function deactivateSelected() {
  const targets = selectedUsers.value.filter(u => u.active && !u.owner && !isSystemUser(u))
  const skipped = selectedUsers.value.filter(u => u.owner || isSystemUser(u)).length
  if (targets.length === 0) return
  try {
    await dataApi.patch(dataApi.resourcePath('totalbase', 'users'), { data: { active: false } }, { 'where[id][_in]': targets.map(u => u.id).join(',') })
    toast.add({
      title: t('users.usersList.deactivated', targets.length),
      description: skipped ? t('users.usersList.skipped') : undefined,
      color: 'success'
    })
    rowSelection.value = {}
    await refreshUsersData()
  } catch (err) {
    notifyError(err, t('users.usersList.deactivateError'))
  }
}

// Header: Refresh (PageHeader's "⋮" on a phone) and the bulk actions
// while rows are selected.
const headerActions = computed<HeaderAction[]>(() => [
  { label: t('users.usersList.refresh'), icon: 'i-lucide-refresh-cw', iconOnly: true, loading: refreshing.value, onSelect: refreshUsers }
])
const headerSelection = computed<HeaderSelection>(() => ({
  count: selectedUsers.value.length,
  actions: [
    { label: t('users.usersList.addToRoleEllipsis'), icon: 'i-lucide-user-plus', onSelect: () => openRoleAction('add') },
    { label: t('users.usersList.removeFromRoleEllipsis'), icon: 'i-lucide-user-minus', onSelect: () => openRoleAction('remove') },
    { label: t('users.roleEditor.deactivate'), icon: 'i-lucide-user-x', onSelect: deactivateSelected },
    { label: t('common.delete'), icon: 'i-lucide-trash-2', color: 'error', onSelect: () => openDrop(selectedUsers.value) }
  ],
  onClear: () => {
    rowSelection.value = {}
  }
}))
</script>

<template>
  <PageShell>
    <!-- Header: bulk actions once rows are checked, then search and
    refresh - New user / Invite live in the panel. -->
    <template #header>
      <PageHeader
        :title="headerTitle"
        :description="headerDescription"
        icon="i-lucide-users"
        :actions="headerActions"
        :selection="headerSelection"
      >
        <template #search>
          <HeaderSearch
            v-model="search"
            :placeholder="t('users.usersList.search')"
            class="w-64"
          />
          <!-- Filter by the project's own columns - a select each; the active ones as chips below. -->
          <UPopover v-if="filterColumns.length">
            <UButton
              icon="i-lucide-list-filter"
              :label="t('users.usersList.filter')"
              color="neutral"
              variant="outline"
              :aria-label="t('users.usersList.filter')"
            />
            <template #content>
              <div class="flex w-72 flex-col gap-3 p-3">
                <UFormField
                  v-for="column in filterColumns"
                  :key="column.name"
                  :label="column.label"
                >
                  <USelectMenu
                    :model-value="(route.query[extraKey(column.name)] as string | undefined)"
                    :items="column.options!.map(o => ({ value: o.value, label: o.value === '' ? optionLabel(column.name, '') : o.label }))"
                    value-key="value"
                    label-key="label"
                    :search-input="(column.options?.length ?? 0) > 8"
                    class="w-full"
                    @update:model-value="(v: string) => setExtraFilter(column.name, v)"
                  />
                </UFormField>
              </div>
            </template>
          </UPopover>
        </template>
      </PageHeader>
    </template>

    <template
      v-if="activeExtraFilters.length"
      #toolbar
    >
      <div class="flex flex-wrap gap-2">
        <UBadge
          v-for="filter in activeExtraFilters"
          :key="filter.column"
          color="neutral"
          variant="subtle"
          class="gap-1"
        >
          {{ filter.label }}: {{ optionLabel(filter.column, filter.value) }}
          <UButton
            icon="i-lucide-x"
            color="neutral"
            variant="link"
            size="xs"
            class="p-0"
            :aria-label="t('users.usersList.clearFilter', { column: filter.label })"
            @click="setExtraFilter(filter.column, undefined)"
          />
        </UBadge>
      </div>
    </template>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="error.message"
    />

    <div>
      <UTable
        v-model:row-selection="rowSelection"
        sticky
        :data="rows"
        :columns="columns"
        :loading="pending"
        :get-row-id="(row: AdminUserListItem) => row.id"
        :on-select="(_e: Event, row: { original: AdminUserListItem }) => navigateTo(`/users/${row.original.id}`)"
      >
        <template #select-header="{ table }">
          <UCheckbox
            :model-value="table.getIsSomePageRowsSelected() ? 'indeterminate' : table.getIsAllPageRowsSelected()"
            :aria-label="t('users.common.selectPage')"
            @update:model-value="(v: boolean | 'indeterminate') => table.toggleAllPageRowsSelected(v === true)"
            @click.stop
          />
        </template>
        <template #select-cell="{ row }">
          <UCheckbox
            :model-value="row.getIsSelected()"
            :aria-label="t('users.common.selectUser', { user: row.original.name ?? row.original.email ?? t('users.usersList.userFallback') })"
            @update:model-value="(v: boolean | 'indeterminate') => row.toggleSelected(v === true)"
            @click.stop
          />
        </template>
        <template #name-cell="{ row }">
          <div class="flex items-center gap-3 cursor-pointer min-w-0">
            <UAvatar
              :src="row.original.avatarUrl ?? undefined"
              :alt="row.original.name ?? row.original.email ?? undefined"
              size="sm"
            />
            <div class="flex flex-col min-w-0">
              <span class="font-medium truncate">{{ row.original.name ?? '—' }}</span>
              <span class="text-xs text-muted truncate">{{ row.original.email ?? '—' }}</span>
            </div>
          </div>
        </template>
        <template #roles-cell="{ row }">
          <div class="flex flex-wrap items-center gap-1">
            <UBadge
              v-for="roleId in row.original.roles.slice(0, MAX_ROLE_BADGES)"
              :key="roleId"
              :label="roleById.get(roleId)?.name ?? t('users.usersList.unknown')"
              color="neutral"
              variant="outline"
              size="sm"
            />
            <span
              v-if="row.original.roles.length > MAX_ROLE_BADGES"
              class="text-xs text-muted"
            >+{{ row.original.roles.length - MAX_ROLE_BADGES }}</span>
            <span
              v-if="row.original.roles.length === 0"
              class="text-muted"
            >—</span>
          </div>
        </template>
        <template #status-cell="{ row }">
          <div class="flex items-center gap-2">
            <UBadge
              :color="USER_STATUS_META[userStatus(row.original)].color"
              variant="subtle"
              size="sm"
            >
              {{ t(USER_STATUS_META[userStatus(row.original)].labelKey) }}
            </UBadge>
            <UBadge
              v-if="row.original.lockedUntil"
              icon="i-lucide-lock"
              color="error"
              variant="subtle"
              size="sm"
            >
              {{ t('users.userEditor.locked') }}
            </UBadge>
            <UBadge
              v-if="row.original.owner"
              color="warning"
              variant="outline"
              size="sm"
            >
              {{ t('users.userEditor.owner') }}
            </UBadge>
            <UBadge
              v-if="isSystemUser(row.original)"
              color="info"
              variant="outline"
              size="sm"
            >
              {{ t('users.userEditor.system') }}
            </UBadge>
          </div>
        </template>
        <template #lastLoginAt-cell="{ row }">
          <span class="text-xs text-muted">{{ formatDate(row.original.lastLoginAt) }}</span>
        </template>
        <template #actions-cell="{ row }">
          <UDropdownMenu :items="actionItems(row.original)">
            <UButton
              icon="i-lucide-ellipsis-vertical"
              color="neutral"
              variant="ghost"
              size="xs"
              :aria-label="t('users.roleEditor.rowActions', { name: row.original.name ?? row.original.email ?? t('users.usersList.userFallback') })"
              :loading="togglingRowId === row.original.id"
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
        :total="total"
        :noun="t('users.usersList.noun')"
        :plural="t('users.usersList.nounPlural')"
      />
    </template>

    <UModal
      v-model:open="isDeleteOpen"
      :title="deleteModalTitle"
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <p class="text-sm text-muted">
            {{ t('users.usersList.deleteBody') }}
          </p>
          <ul class="flex flex-col gap-1 max-h-48 overflow-y-auto border border-default rounded-lg p-2">
            <li
              v-for="u in dropTargets"
              :key="u.id"
              class="text-sm truncate"
            >
              {{ u.name ?? u.email ?? u.id }}
            </li>
          </ul>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full items-center justify-between gap-2">
          <UCheckbox
            v-model="dropConfirmed"
            :label="t('common.confirm')"
          />
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
      </template>
    </UModal>
    <PickRoleModal
      v-model:open="roleActionOpen"
      :title="roleAction === 'remove' ? t('users.usersList.removeFromRole') : t('users.usersList.addToRole')"
      :description="t('users.usersList.selectedUsers', roleTargets.length)"
      :confirm-label="roleAction === 'remove' ? t('common.remove') : t('common.add')"
      :loading="bulkBusy"
      @pick="applyRole"
    />
  </PageShell>
</template>
