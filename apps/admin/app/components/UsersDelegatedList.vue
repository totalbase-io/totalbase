<script setup lang="ts">
/**
 * The Users table for a delegated user (pages/users/index.vue;
 * Security.md §9.3): the users and columns their
 * permissions allow, through the Data API - searched, paged and counted in
 * PostgreSQL. A row opens the user's page. Invite lives in the panel.
 */
// Absolute dates/times in the user's zone and format (My account > Preferences).
const dates = useDateTimeFormat()
const dataApi = useDataApi()
const { t } = useI18n()

interface UserRow {
  id: string
  name?: string | null
  email?: string | null
  avatar_url?: string | null
  active?: boolean
  created_at?: string
}

const search = ref('')
const debouncedSearch = useDebouncedRef(() => search.value.trim())

const prefs = usePagePreferences('users', { pageSize: 10 })
const page = ref(1)

// No `fields`: a column the caller may not read is left out, not an error.
const { data: pageData, pending, error, refresh } = await useAsyncData(
  'users-page',
  () => dataApi.get<UserRow[]>(dataApi.resourcePath('totalbase', 'users'), {
    limit: prefs.pageSize,
    offset: (page.value - 1) * prefs.pageSize,
    order_by: 'name',
    count: true,
    ...(debouncedSearch.value && { search: debouncedSearch.value })
  }).then(r => ({ users: r.data, total: r.meta?.count ?? r.data.length })),
  {
    default: () => ({ users: [] as UserRow[], total: 0 }),
    watch: [page, () => prefs.pageSize, debouncedSearch]
  }
)
const rows = computed(() => pageData.value?.users ?? [])
const total = computed(() => pageData.value?.total ?? 0)
watch([debouncedSearch, () => prefs.pageSize], () => {
  page.value = 1
})

const columns = computed(() => [
  { accessorKey: 'name', header: t('common.user') },
  { id: 'status', header: t('common.status') },
  { accessorKey: 'created_at', header: t('users.userEditor.signIn.created') }
])

const refreshing = ref(false)
async function refreshUsers() {
  refreshing.value = true
  try {
    await refresh()
  } finally {
    refreshing.value = false
  }
}
// Header: Refresh (PageHeader's "⋮" on a phone).
const headerActions = computed<HeaderAction[]>(() => [
  { label: t('users.usersList.refresh'), icon: 'i-lucide-refresh-cw', iconOnly: true, loading: refreshing.value, onSelect: refreshUsers }
])
</script>

<template>
  <PageShell>
    <template #header>
      <PageHeader
        :title="t('common.users')"
        :description="t('users.usersDelegated.description')"
        icon="i-lucide-users"
        :actions="headerActions"
      >
        <template #search>
          <HeaderSearch
            v-model="search"
            :placeholder="t('users.usersList.search')"
            class="w-64"
          />
        </template>
      </PageHeader>
    </template>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="error.message"
    />

    <UTable
      sticky
      :data="rows"
      :columns="columns"
      :loading="pending"
      :get-row-id="(row: UserRow) => row.id"
      :on-select="(_e: Event, row: { original: UserRow }) => navigateTo(`/users/${row.original.id}`)"
    >
      <template #name-cell="{ row }">
        <div class="flex min-w-0 cursor-pointer items-center gap-3">
          <UAvatar
            :src="row.original.avatar_url ?? undefined"
            :alt="row.original.name ?? row.original.email ?? undefined"
            size="sm"
          />
          <div class="flex min-w-0 flex-col">
            <span class="truncate font-medium">{{ row.original.name ?? '—' }}</span>
            <span class="truncate text-xs text-muted">{{ row.original.email ?? '—' }}</span>
          </div>
        </div>
      </template>
      <template #status-cell="{ row }">
        <UBadge
          v-if="row.original.active !== undefined"
          :color="row.original.active ? 'success' : 'neutral'"
          variant="subtle"
          size="sm"
        >
          {{ row.original.active ? t('users.status.ACTIVE') : t('users.status.INACTIVE') }}
        </UBadge>
        <span
          v-else
          class="text-muted"
        >—</span>
      </template>
      <template #created_at-cell="{ row }">
        <span class="text-xs text-muted">{{ row.original.created_at ? dates.dateTime(row.original.created_at) : '—' }}</span>
      </template>
    </UTable>

    <template #footer>
      <TablePager
        v-model:page="page"
        v-model:page-size="prefs.pageSize"
        :total="total"
        :noun="t('users.usersList.noun')"
        :plural="t('users.usersList.nounPlural')"
      />
    </template>
  </PageShell>
</template>
