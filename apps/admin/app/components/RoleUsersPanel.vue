<script setup lang="ts">
/**
 * A role's Members tab (pages/roles/[id].vue): every user with a switch, the
 * role's holders first (GET /users?role_first=<id>, paged and searched in
 * PostgreSQL - never every user at once), or only its members / only the
 * rest. A switch applies at once: PUT /users/:id/roles with the user's other
 * roles sent back unchanged. The order is the server's for the page shown -
 * a row doesn't move when its switch changes; it does on the next load.
 * New user / Invite create an account that already holds this role.
 *
 * `locked`: the system-only Workflows role - its one member is seeded,
 * nobody can be added or removed here (the server refuses it anyway).
 *
 * Each member's "⋮": their page, when their assignment ends (Security.md
 * §1.10, never on a reserved role), and moving them to another role.
 */
import { isSystemUser, type AdminUser, type AdminUserListItem } from '~/types/security'
// Absolute dates/times in the user's zone and format (My account > Preferences).
const dates = useDateTimeFormat()

const props = defineProps<{
  roleId: string
  roleName: string
  /** The reserved Administrators role - its members include the owner, who can't lose it. */
  adminRole: boolean
  locked: boolean
}>()

const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()
const rolesApi = useRolesApi()
const { data: roles } = useRoleOptions()
const { data: incompatibilities } = useRoleIncompatibilities()

// --- The list: one server-ordered page at a time. ---
type Membership = 'ALL' | 'MEMBERS' | 'NOT_MEMBERS'
const membership = ref<Membership>('ALL')
const membershipItems = computed(() => [
  { label: t('users.roleMembers.filter.all'), value: 'ALL' },
  { label: t('users.roleMembers.filter.members'), value: 'MEMBERS' },
  { label: t('users.roleMembers.filter.notMembers'), value: 'NOT_MEMBERS' }
])
const search = ref('')
const debouncedSearch = useDebouncedRef(() => search.value.trim())
const page = ref(1)
const pageSize = ref(50)

const users = ref<AdminUserListItem[]>([])
const total = ref(0)
const memberCount = ref(0)
const loading = ref(false)
const loadError = ref(false)
// Only the latest page lands: a search typed faster than the server answers must not show an older page.
const latest = useLatest()

async function load() {
  const current = latest.next()
  loading.value = true
  loadError.value = false
  try {
    const [{ data, meta }, members] = await Promise.all([
      api.get<AdminUserListItem[]>('/users', {
        role_first: props.roleId,
        ...(membership.value === 'MEMBERS' && { role: props.roleId }),
        ...(membership.value === 'NOT_MEMBERS' && { not_role: props.roleId }),
        ...(debouncedSearch.value && { q: debouncedSearch.value }),
        limit: pageSize.value,
        offset: (page.value - 1) * pageSize.value
      }),
      api.get<AdminUserListItem[]>('/users', { role: props.roleId, limit: 1 })
    ])
    const held = props.adminRole || props.locked ? [] : data.filter(u => u.roles.includes(props.roleId)).map(u => u.id)
    const loadedExpiries = await rolesApi.expiries(props.roleId, held)
    if (!current.isCurrent()) return
    users.value = data
    total.value = meta?.total ?? data.length
    memberCount.value = members.meta?.total ?? 0
    expiries.value = loadedExpiries
  } catch {
    if (current.isCurrent()) loadError.value = true
  } finally {
    if (current.isCurrent()) loading.value = false
  }
}
watch([debouncedSearch, membership, pageSize], () => {
  if (page.value !== 1) page.value = 1
  else void load()
})
watch(page, () => load())
onMounted(load)

async function afterChange() {
  await Promise.all([load(), refreshUsersData()])
}

function formatDate(value: string | null) {
  return value ? dates.dateTime(value) : t('users.common.never')
}
const holds = (user: AdminUserListItem) => user.roles.includes(props.roleId)

// --- A switch per user, applied at once. ---
/** Why this user's switch can't change, or null. */
function switchLocked(user: AdminUserListItem): string | null {
  if (props.locked || isSystemUser(user)) return t('users.roleMembers.systemRole')
  if (holds(user)) return props.adminRole && user.owner ? t('users.roleMembers.ownerKeeps') : null
  const clashes = incompatibleWith(incompatibilities.value, props.roleId, user.roles)
  if (clashes.length === 0) return null
  return t('users.userEditor.roleIncompatible', { roles: clashes.map(id => roles.value?.find(r => r.id === id)?.name ?? id).join(', ') })
}
const switching = ref<string | null>(null)
async function toggle(user: AdminUserListItem, on: boolean) {
  const next = on ? [...user.roles, props.roleId] : user.roles.filter(id => id !== props.roleId)
  switching.value = user.id
  try {
    await api.put(`/users/${user.id}/roles`, { data: { roleIds: next } })
    // In place: the row keeps its position until the next load.
    user.roles = next
    memberCount.value += on ? 1 : -1
    if (!on) expiries.value.delete(user.id)
    toast.add({
      title: on
        ? t('users.roleDelegated.added', { user: user.name || user.email, role: props.roleName })
        : t('users.roleDelegated.removed', { role: props.roleName }),
      color: 'success'
    })
    await refreshUsersData()
  } catch (err) {
    notifyError(err, on ? t('users.roleDelegated.addError') : t('users.roleDelegated.removeError'))
  } finally {
    switching.value = null
  }
}

// --- When a member's assignment ends (Security.md §1.10): a small modal from the member's "⋮". ---
const expiries = ref(new Map<string, string>())
const expiryUser = ref<AdminUserListItem | null>(null)
const expiryDate = ref('')
const savingExpiry = ref(false)
function openExpiry(user: AdminUserListItem) {
  const current = expiries.value.get(user.id)
  expiryDate.value = current ? current.slice(0, 10) : ''
  expiryUser.value = user
}
async function saveExpiry(clear: boolean) {
  const user = expiryUser.value
  if (!user) return
  savingExpiry.value = true
  try {
    // The end of the chosen day, in the viewer's zone.
    const expiresAt = clear || !expiryDate.value ? null : new Date(`${expiryDate.value}T23:59:59`).toISOString()
    await api.put(`/users/${user.id}/roles/${props.roleId}/expiry`, { data: { expiresAt } })
    const next = new Map(expiries.value)
    if (expiresAt) next.set(user.id, expiresAt)
    else next.delete(user.id)
    expiries.value = next
    expiryUser.value = null
  } catch (err) {
    notifyError(err, t('users.roleMembers.expiryError'))
  } finally {
    savingExpiry.value = false
  }
}

// --- Move to another role: this one taken away, the other given, in one request (Security.md §9.4). ---
const moveUser = ref<AdminUserListItem | null>(null)
const moveOpen = computed({
  get: () => moveUser.value !== null,
  set: (open: boolean) => { if (!open) moveUser.value = null }
})
const moving = ref(false)
async function move(otherRoleId: string) {
  const user = moveUser.value
  if (!user) return
  moving.value = true
  try {
    await rolesApi.moveMembers(props.roleId, otherRoleId, [user.id])
    toast.add({ title: t('users.roleMembers.bulkDone.move', { role: props.roleName }, 1), color: 'success' })
    moveUser.value = null
    await afterChange()
  } catch (err) {
    notifyError(err, t('users.roleMembers.bulkError'))
  } finally {
    moving.value = false
  }
}

function memberMenu(user: AdminUserListItem) {
  const member = holds(user) && !switchLocked(user)
  return [[
    { label: t('users.roleMembers.openUser'), icon: 'i-lucide-arrow-up-right', to: `/users/${user.id}` },
    ...(member && !props.adminRole
      ? [{ label: t('users.roleMembers.setExpiryItem'), icon: 'i-lucide-calendar-clock', onSelect: () => openExpiry(user) }]
      : []),
    ...(member
      ? [{ label: t('users.roleMembers.moveToRoleEllipsis'), icon: 'i-lucide-arrow-right-left', onSelect: () => { moveUser.value = user } }]
      : [])
  ]]
}

// --- New user / Invite - shared modals, with the role fixed to this one. ---
const createOpen = ref(false)
const inviteOpen = ref(false)
async function onCreated(_user: AdminUser) {
  await afterChange()
}
</script>

<template>
  <PageShell>
    <template #toolbar>
      <!-- The list's width, so the search and its actions line up with the rows. -->
      <div class="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2">
        <UInput
          v-model="search"
          icon="i-lucide-search"
          :placeholder="t('users.roleMembers.searchUsers')"
          :aria-label="t('users.roleMembers.searchUsers')"
          class="min-w-48 flex-1"
        />
        <USelect
          v-model="membership"
          :items="membershipItems"
          :aria-label="t('users.roleMembers.filter.label')"
          class="w-40"
        />
        <template v-if="!locked">
          <UButton
            :label="t('users.roleMembers.newUser')"
            icon="i-lucide-plus"
            color="neutral"
            variant="outline"
            @click="createOpen = true"
          />
          <UButton
            :label="t('users.roleMembers.invitePeople')"
            icon="i-lucide-mail"
            @click="inviteOpen = true"
          />
        </template>
      </div>
    </template>

    <div class="mx-auto flex w-full max-w-3xl flex-col gap-3">
      <UAlert
        v-if="locked"
        color="neutral"
        variant="subtle"
        icon="i-lucide-lock"
        :title="t('users.roleMembers.systemRole')"
        :description="t('users.roleMembers.systemRoleDescription')"
      />
      <i18n-t
        keypath="users.roleDelegated.memberCount"
        :plural="memberCount"
        tag="p"
        class="text-sm text-muted"
      >
        <template #count>
          {{ memberCount }}
        </template>
        <template #role>
          <span class="font-medium">{{ roleName }}</span>
        </template>
      </i18n-t>
      <UAlert
        v-if="loadError"
        color="error"
        variant="subtle"
        :title="t('users.roleDelegated.loadMembersError')"
      />
      <UEmpty
        v-else-if="users.length === 0"
        :loading="loading"
        icon="i-lucide-users"
        :title="debouncedSearch ? t('users.roleDelegated.noMatch', { search: debouncedSearch }) : t('users.roleMembers.noUsers')"
        variant="naked"
      />
      <ListCard v-else>
        <div
          v-for="user in users"
          :key="user.id"
          class="flex items-center gap-3 px-3 py-2.5"
        >
          <UUser
            :name="user.name || user.email || user.id"
            :description="user.name ? (user.email ?? undefined) : undefined"
            :avatar="{ src: user.avatarUrl ?? undefined, alt: user.name || user.email || user.id }"
            size="sm"
            class="min-w-0 flex-1"
          />
          <UBadge
            v-if="expiries.get(user.id)"
            :label="t('users.roleMembers.expires', { date: formatDate(expiries.get(user.id)!) })"
            color="warning"
            variant="subtle"
            size="sm"
            class="shrink-0"
          />
          <span class="hidden max-w-64 shrink-0 truncate text-xs text-muted sm:inline">
            {{ switchLocked(user) ?? t('users.roleMembers.lastSignIn', { date: formatDate(user.lastLoginAt) }) }}
          </span>
          <USwitch
            :model-value="holds(user)"
            :disabled="!!switchLocked(user) || switching !== null"
            :loading="switching === user.id"
            :aria-label="t('users.roleMembers.holds', { user: user.name || user.email, role: roleName })"
            @update:model-value="(on: boolean) => toggle(user, on)"
          />
          <UDropdownMenu :items="memberMenu(user)">
            <UButton
              icon="i-lucide-ellipsis-vertical"
              color="neutral"
              variant="ghost"
              size="sm"
              :aria-label="t('users.roleMembers.memberActions', { user: user.name || user.email })"
            />
          </UDropdownMenu>
        </div>
      </ListCard>
    </div>

    <template #footer>
      <TablePager
        v-model:page="page"
        v-model:page-size="pageSize"
        :total="total"
        :noun="t('users.usersList.noun')"
        :plural="t('users.usersList.nounPlural')"
        :page-size-options="[25, 50, 100, 200]"
      />
    </template>

    <UModal
      :open="!!expiryUser"
      :title="t('users.roleMembers.setExpiry', { user: expiryUser?.name || expiryUser?.email || '' })"
      @update:open="(open: boolean) => { if (!open) expiryUser = null }"
    >
      <template #body>
        <UFormField
          :label="t('users.roleMembers.expiryLabel')"
          :description="t('users.roleMembers.expiryHelp')"
        >
          <UInput
            v-model="expiryDate"
            type="date"
            class="w-full"
          />
        </UFormField>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            v-if="expiryUser && expiries.get(expiryUser.id)"
            :label="t('users.roleMembers.expiryClear')"
            color="neutral"
            variant="ghost"
            :disabled="savingExpiry"
            @click="saveExpiry(true)"
          />
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="ghost"
            :disabled="savingExpiry"
            @click="expiryUser = null"
          />
          <UButton
            :label="t('common.save')"
            :loading="savingExpiry"
            :disabled="!expiryDate"
            @click="saveExpiry(false)"
          />
        </div>
      </template>
    </UModal>

    <UserCreateModal
      v-model:open="createOpen"
      :role-id="roleId"
      @created="onCreated"
    />
    <UserInviteModal
      v-model:open="inviteOpen"
      :role-id="roleId"
      @created="onCreated"
    />
    <PickRoleModal
      v-model:open="moveOpen"
      :title="t('users.roleMembers.moveToRole')"
      :description="t('users.roleMembers.moveDescription', { user: moveUser?.name || moveUser?.email || '', role: roleName })"
      :confirm-label="t('users.roleMembers.move')"
      :exclude-role-ids="[roleId]"
      :loading="moving"
      @pick="move"
    />
  </PageShell>
</template>
