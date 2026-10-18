<script setup lang="ts">
/**
 * The Users rail group's own nav panel (layouts/default.vue's aside,
 * `activeGroupKey === 'users'`). Unlike RolesTree.vue it doesn't list
 * every user - that list can grow to thousands - it filters the table on
 * pages/users/index.vue instead, through the route query (`?status=`,
 * `?role=`), so a filtered view is a shareable URL. Counts come from
 * GET /users/summary, never the rows themselves. Below the filters, the
 * global Tokens/Sessions views (a single user's live on that user's page).
 *
 * New user / Invite live here, same as TemplatesTree.vue's "New
 * template"; on success the new user's page opens.
 */
import { USER_STATUS_META, type AdminUser, type UserStatus } from '~/types/security'

const api = useAdminApi()
const route = useRoute()
const { t } = useI18n()
const { data: roleOptions } = useRoleOptions()

interface UsersSummary {
  total: number
  byStatus: Record<UserStatus, number>
  byRole: Record<string, number>
  /** Tokens that still authenticate, sessions still signed in. */
  credentials: { tokens: number, sessions: number }
}

// Counts only - the list itself lives on the page, paged by the server.
const { data: summary } = useAsyncData(
  'users-summary',
  () => api.get<UsersSummary>('/users/summary').then(r => r.data)
)

const STATUSES: UserStatus[] = ['ACTIVE', 'INVITED', 'INACTIVE']

const statusCounts = computed(() => summary.value?.byStatus ?? { ACTIVE: 0, INVITED: 0, INACTIVE: 0 })
const roleCounts = computed(() => new Map(Object.entries(summary.value?.byRole ?? {})))
const sortedRoles = computed(() => [...(roleOptions.value ?? [])].sort((a, b) => a.name.localeCompare(b.name)))

const onList = computed(() => route.path === '/users')
const activeStatus = computed(() => onList.value ? route.query.status as string | undefined : undefined)
const activeRole = computed(() => onList.value ? route.query.role as string | undefined : undefined)
const allActive = computed(() => onList.value && !activeStatus.value && !activeRole.value)
/** The list's filters by the project's own columns (?extra[<column>]=) - kept when a status or a role is picked: they combine. */
const extraQuery = computed(() => (onList.value ? Object.fromEntries(Object.entries(route.query).filter(([key]) => key.startsWith('extra['))) : {}))

const ITEM_CLASS = 'flex w-full min-w-0 items-center gap-2 rounded px-3 py-1.5 text-left text-sm hover:bg-elevated hover:text-highlighted'
function itemClass(active: boolean) {
  return [ITEM_CLASS, active ? 'bg-elevated text-highlighted' : 'text-default']
}

const createOpen = ref(false)
const inviteOpen = ref(false)

async function onCreated(user: AdminUser) {
  await refreshUsersData()
  await navigateTo(`/users/${user.id}`)
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex gap-2">
      <UButton
        icon="i-lucide-plus"
        :label="t('users.roleMembers.newUser')"
        class="flex-1 justify-center"
        @click="createOpen = true"
      />
      <UTooltip :text="t('users.usersPanel.inviteByEmail')">
        <UButton
          icon="i-lucide-mail-plus"
          color="neutral"
          variant="outline"
          :aria-label="t('users.userInvite.title')"
          @click="inviteOpen = true"
        />
      </UTooltip>
    </div>

    <section>
      <div class="pb-2 text-xs font-medium uppercase tracking-wide text-muted">
        {{ t('common.status') }}
      </div>
      <NuxtLink
        to="/users"
        :class="itemClass(allActive)"
      >
        <UIcon
          name="i-lucide-users"
          class="size-4 shrink-0 text-muted"
        />
        <span class="truncate">{{ t('users.usersDelegated.allUsers') }}</span>
        <span class="ms-auto text-xs text-muted">{{ summary?.total ?? 0 }}</span>
      </NuxtLink>
      <NuxtLink
        v-for="status in STATUSES"
        :key="status"
        :to="{ path: '/users', query: { ...extraQuery, status } }"
        :class="itemClass(activeStatus === status)"
      >
        <span
          class="size-2 mx-1 shrink-0 rounded-full"
          :class="{ 'bg-success': status === 'ACTIVE', 'bg-warning': status === 'INVITED', 'bg-(--ui-text-dimmed)': status === 'INACTIVE' }"
        />
        <span class="truncate">{{ t(USER_STATUS_META[status].labelKey) }}</span>
        <span class="ms-auto text-xs text-muted">{{ statusCounts[status] }}</span>
      </NuxtLink>
    </section>

    <section>
      <div class="pb-2 text-xs font-medium uppercase tracking-wide text-muted">
        {{ t('common.roles') }}
      </div>
      <NuxtLink
        v-for="role in sortedRoles"
        :key="role.id"
        :to="{ path: '/users', query: { ...extraQuery, role: role.id } }"
        :class="itemClass(activeRole === role.id)"
      >
        <UIcon
          name="i-lucide-shield"
          class="size-4 shrink-0 text-muted"
        />
        <span class="truncate">{{ role.name }}</span>
        <span class="ms-auto text-xs text-muted">{{ roleCounts.get(role.id) ?? 0 }}</span>
      </NuxtLink>
    </section>

    <section>
      <div class="pb-2 text-xs font-medium uppercase tracking-wide text-muted">
        {{ t('users.usersPanel.credentials') }}
      </div>
      <NuxtLink
        to="/tokens"
        :class="itemClass(route.path === '/tokens')"
      >
        <UIcon
          name="i-lucide-key-round"
          class="size-4 shrink-0 text-muted"
        />
        <span class="truncate">{{ t('users.pages.tokens.title') }}</span>
        <span class="ms-auto text-xs text-muted">{{ summary?.credentials?.tokens ?? 0 }}</span>
      </NuxtLink>
      <NuxtLink
        to="/sessions"
        :class="itemClass(route.path === '/sessions')"
      >
        <UIcon
          name="i-lucide-monitor-smartphone"
          class="size-4 shrink-0 text-muted"
        />
        <span class="truncate">{{ t('users.pages.sessions.title') }}</span>
        <span class="ms-auto text-xs text-muted">{{ summary?.credentials?.sessions ?? 0 }}</span>
      </NuxtLink>
    </section>

    <section>
      <div class="pb-2 text-xs font-medium uppercase tracking-wide text-muted">
        {{ t('users.activity.insights') }}
      </div>
      <NuxtLink
        to="/users/insights/sign-ins"
        :class="itemClass(route.path === '/users/insights/sign-ins')"
      >
        <UIcon
          name="i-lucide-log-in"
          class="size-4 shrink-0 text-muted"
        />
        <span class="truncate">{{ t('users.usersPanel.signIns') }}</span>
      </NuxtLink>
      <NuxtLink
        to="/users/insights/activity"
        :class="itemClass(route.path === '/users/insights/activity')"
      >
        <UIcon
          name="i-lucide-activity"
          class="size-4 shrink-0 text-muted"
        />
        <span class="truncate">{{ t('users.userEditor.tabs.activity') }}</span>
      </NuxtLink>
    </section>

    <UserCreateModal
      v-model:open="createOpen"
      @created="onCreated"
    />
    <UserInviteModal
      v-model:open="inviteOpen"
      @created="onCreated"
    />
  </div>
</template>
