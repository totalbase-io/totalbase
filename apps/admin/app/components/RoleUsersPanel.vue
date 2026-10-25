<script setup lang="ts">
/**
 * A role's Members tab (pages/roles/[id].vue). Only the role's members
 * are loaded - GET /users?role=<id>, paged and searched in PostgreSQL -
 * never every user. Adding someone goes through a remote search box
 * (GET /users?q=...); removing drops just this role from their set
 * (PUT /users/:id/roles replaces the whole array, so the user's other
 * roles are sent back unchanged). New user / Invite create an account
 * that already holds this role.
 *
 * `locked`: the system-only Workflows role - its one member is seeded,
 * nobody can be added or removed here (the server refuses it anyway).
 *
 * Each member's assignment may end (Security.md §1.10): shown beside them,
 * set from the calendar button - never on a reserved role.
 */
import type { AdminUser, AdminUserListItem } from '~/types/security'
import { useApiErrorMessage } from '~/utils/api-error-message'
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
const errorMessage = useApiErrorMessage()
const notifyError = useErrorToast()

const PAGE_SIZE = 50

// --- Members: one server-filtered page at a time, "Load more" appends. ---
const search = ref('')
const debouncedSearch = useDebouncedRef(() => search.value.trim())

const members = ref<AdminUserListItem[]>([])
const total = ref(0)
const loading = ref(false)
const loadError = ref<string | null>(null)
// Only the latest page lands: a search typed faster than the server answers must not show an older page.
const latestMembers = useLatest()

async function loadMembers(reset: boolean) {
  const load = latestMembers.next()
  loading.value = true
  loadError.value = null
  try {
    const { data, meta } = await api.get<AdminUserListItem[]>('/users', {
      role: props.roleId,
      limit: PAGE_SIZE,
      offset: reset ? 0 : members.value.length,
      ...(debouncedSearch.value && { q: debouncedSearch.value })
    })
    if (!load.isCurrent()) return
    members.value = reset ? data : [...members.value, ...data]
    total.value = meta?.total ?? members.value.length
    if (!props.adminRole && !props.locked) {
      const loaded = await rolesApi.expiries(props.roleId, data.map(user => user.id))
      expiries.value = new Map([...(reset ? [] : expiries.value), ...loaded])
    }
  } catch (err) {
    if (load.isCurrent()) loadError.value = errorMessage(err, t('users.roleDelegated.loadMembersError'))
  } finally {
    if (load.isCurrent()) loading.value = false
  }
}
watch(debouncedSearch, () => loadMembers(true))
onMounted(() => loadMembers(true))

// --- When a member's assignment ends (Security.md §1.10): a small popover per member. ---
const expiries = ref(new Map<string, string>())
const expiryUser = ref<string | null>(null)
const expiryDate = ref('')
const savingExpiry = ref(false)
function openExpiry(userId: string) {
  const current = expiries.value.get(userId)
  expiryDate.value = current ? current.slice(0, 10) : ''
  expiryUser.value = userId
}
async function saveExpiry(clear: boolean) {
  const userId = expiryUser.value
  if (!userId) return
  savingExpiry.value = true
  try {
    // The end of the chosen day, in the viewer's zone.
    const expiresAt = clear || !expiryDate.value ? null : new Date(`${expiryDate.value}T23:59:59`).toISOString()
    await api.put(`/users/${userId}/roles/${props.roleId}/expiry`, { data: { expiresAt } })
    const next = new Map(expiries.value)
    if (expiresAt) next.set(userId, expiresAt)
    else next.delete(userId)
    expiries.value = next
    expiryUser.value = null
  } catch (err) {
    notifyError(err, t('users.roleMembers.expiryError'))
  } finally {
    savingExpiry.value = false
  }
}

async function afterChange() {
  await Promise.all([loadMembers(true), refreshUsersData(), loadHistory()])
}

// --- Access review: who was added to / removed from this role, by whom
// and when - the audit log's role changes (GET /audit/logs?role_change=),
// plus each member's last sign-in above. ---
interface RoleChangeEntry {
  id: string
  principalId: string | null
  status: 'EXECUTED' | 'FAILED' | 'DENIED'
  createdAt: string
  metadata: { event?: string, user_id?: string, roles_added?: string[], roles_removed?: string[] }
  /** A Data API assignment write (a delegated user's): the assignment row - its user and role. */
  payload?: { user?: string, role?: string } | null
}

/** Whether the entry added the role - the Admin API's role set change, or a Data API assignment written. */
function wasAdded(entry: RoleChangeEntry): boolean {
  return entry.metadata.event === 'assignment.create' || !!entry.metadata.roles_added?.includes(props.roleId)
}
/** Who gained or lost the role. */
function changedUser(entry: RoleChangeEntry): string | undefined {
  return entry.metadata.user_id ?? entry.payload?.user
}
const HISTORY_SIZE = 20
const history = ref<RoleChangeEntry[]>([])
const historyTotal = ref(0)
const historyLoading = ref(false)
const directory = useUserDirectory()

async function loadHistory(more = false) {
  historyLoading.value = true
  try {
    const { data, meta } = await api.get<RoleChangeEntry[]>('/audit/logs', {
      role_change: props.roleId,
      limit: HISTORY_SIZE,
      offset: more ? history.value.length : 0
    })
    history.value = more ? [...history.value, ...data] : data
    historyTotal.value = meta?.total ?? history.value.length
    await directory.ensure(data.flatMap(entry => [entry.principalId, changedUser(entry)]))
  } catch {
    // The audit log is optional context here - the members list stands on its own.
  } finally {
    historyLoading.value = false
  }
}
onMounted(() => loadHistory())

/** The history line's message key - who did what to whom, as one sentence per language. */
function historyKey(entry: RoleChangeEntry): string {
  const verb = wasAdded(entry) ? 'added' : 'removed'
  return `users.roleMembers.history.${entry.status === 'EXECUTED' ? verb : verb === 'added' ? 'triedAdd' : 'triedRemove'}`
}

function formatDate(value: string | null) {
  return value ? dates.dateTime(value) : t('users.common.never')
}

// --- Bulk membership (Security.md §9.4): check members, then
// move them to another role, add another role, or remove them from this one.
// Members this role can't lose (the owner of Administrators, a system role)
// can't be checked. ---
const rolesApi = useRolesApi()
const checked = ref<Set<string>>(new Set())
function toggleChecked(userId: string, on: boolean) {
  const next = new Set(checked.value)
  if (on) next.add(userId)
  else next.delete(userId)
  checked.value = next
}
const bulkAction = ref<'move' | 'add' | null>(null)
const bulkOpen = computed({
  get: () => bulkAction.value !== null,
  set: (open: boolean) => { if (!open) bulkAction.value = null }
})
const bulkBusy = ref(false)
async function runBulk(action: 'move' | 'add' | 'remove', otherRoleId?: string) {
  const userIds = [...checked.value]
  bulkBusy.value = true
  try {
    if (action === 'move') await rolesApi.moveMembers(props.roleId, otherRoleId!, userIds)
    else if (action === 'add') await rolesApi.addMembers(otherRoleId!, userIds)
    else await rolesApi.removeMembers(props.roleId, userIds)
    toast.add({ title: t(`users.roleMembers.bulkDone.${action}`, { role: props.roleName }, userIds.length), color: 'success' })
    bulkAction.value = null
    checked.value = new Set()
    await afterChange()
  } catch (err) {
    notifyError(err, t('users.roleMembers.bulkError'))
  } finally {
    bulkBusy.value = false
  }
}

// --- Remove ---
const removingId = ref<string | null>(null)
function removeLocked(user: AdminUserListItem): boolean {
  return props.locked || (props.adminRole && user.owner)
}
async function removeMember(user: AdminUserListItem) {
  removingId.value = user.id
  try {
    await api.put(`/users/${user.id}/roles`, { data: { roleIds: user.roles.filter(id => id !== props.roleId) } })
    toast.add({ title: t('users.roleDelegated.removed', { role: props.roleName }), color: 'success' })
    await afterChange()
  } catch (err) {
    notifyError(err, t('users.roleDelegated.removeError'))
  } finally {
    removingId.value = null
  }
}

// --- Add an existing user: remote search, members excluded. ---
const addSearch = ref('')
const debouncedAddSearch = useDebouncedRef(() => addSearch.value.trim())
const addResults = ref<AdminUserListItem[]>([])
const addLoading = ref(false)
const latestAddSearch = useLatest()
watch(debouncedAddSearch, async (value) => {
  const load = latestAddSearch.next()
  addLoading.value = true
  try {
    const { data } = await api.get<AdminUserListItem[]>('/users', { limit: 10, ...(value && { q: value }) })
    if (load.isCurrent()) addResults.value = data.filter(u => !u.roles.includes(props.roleId) && u.canLogin)
  } finally {
    if (load.isCurrent()) addLoading.value = false
  }
}, { immediate: true })

const addItems = computed(() => addResults.value.map(u => ({
  label: u.name || u.email || u.id,
  description: u.name ? (u.email ?? undefined) : undefined,
  value: u.id
})))

const adding = ref(false)
// Bound so it can be cleared after each add - the picker is an action,
// not a field that keeps its value.
const addSelection = ref<(typeof addItems.value)[number] | undefined>(undefined)
async function addMember(userId: string | undefined) {
  const user = addResults.value.find(u => u.id === userId)
  if (!user) return
  adding.value = true
  try {
    await api.put(`/users/${user.id}/roles`, { data: { roleIds: [...user.roles, props.roleId] } })
    toast.add({ title: t('users.roleDelegated.added', { user: user.name || user.email, role: props.roleName }), color: 'success' })
    addSearch.value = ''
    await afterChange()
  } catch (err) {
    notifyError(err, t('users.roleDelegated.addError'))
  } finally {
    adding.value = false
    addSelection.value = undefined
  }
}

// --- New user / Invite - shared modals, with the role fixed to this one. ---
const createOpen = ref(false)
const inviteOpen = ref(false)
async function onCreated(_user: AdminUser) {
  await afterChange()
}
</script>

<template>
  <div class="mx-auto flex w-full max-w-2xl flex-col gap-3 pt-4">
    <div class="flex items-center justify-between gap-3">
      <i18n-t
        keypath="users.roleDelegated.memberCount"
        :plural="total"
        tag="p"
        class="text-sm text-muted"
      >
        <template #count>
          {{ total }}
        </template>
        <template #role>
          <span class="font-medium">{{ roleName }}</span>
        </template>
      </i18n-t>
      <div
        v-if="!locked"
        class="flex shrink-0 items-center gap-2"
      >
        <UButton
          :label="t('users.roleMembers.newUser')"
          icon="i-lucide-plus"
          size="sm"
          color="neutral"
          variant="outline"
          @click="createOpen = true"
        />
        <UButton
          :label="t('users.roleMembers.invitePeople')"
          icon="i-lucide-mail"
          size="sm"
          @click="inviteOpen = true"
        />
      </div>
    </div>

    <UAlert
      v-if="locked"
      color="neutral"
      variant="subtle"
      icon="i-lucide-lock"
      :title="t('users.roleMembers.systemRole')"
      :description="t('users.roleMembers.systemRoleDescription')"
    />
    <USelectMenu
      v-else
      v-model="addSelection"
      v-model:search-term="addSearch"
      :items="addItems"
      :loading="addLoading || adding"
      ignore-filter
      icon="i-lucide-user-plus"
      :placeholder="t('users.roleDelegated.addUser')"
      :aria-label="t('users.roleMembers.addUserLabel')"
      class="w-full"
      @update:model-value="(item: { value: string } | undefined) => addMember(item?.value)"
    />

    <UInput
      v-model="search"
      icon="i-lucide-search"
      :placeholder="t('users.roleDelegated.searchMembers')"
      :aria-label="t('users.roleDelegated.searchMembers')"
      class="w-full"
    />

    <UAlert
      v-if="loadError"
      color="error"
      variant="subtle"
      :title="loadError"
    />
    <p
      v-else-if="!loading && members.length === 0"
      class="py-8 text-center text-sm text-muted"
    >
      {{ debouncedSearch ? t('users.roleDelegated.noMatch', { search: debouncedSearch }) : t('users.roleDelegated.noMembers') }}
    </p>
    <div
      v-if="checked.size > 0"
      class="flex flex-wrap items-center gap-2"
    >
      <span class="text-sm">{{ t('users.common.selected', { n: checked.size }) }}</span>
      <UButton
        :label="t('users.roleMembers.moveToRoleEllipsis')"
        icon="i-lucide-arrow-right-left"
        size="xs"
        color="neutral"
        variant="outline"
        @click="bulkAction = 'move'"
      />
      <UButton
        :label="t('users.roleMembers.addAnotherRoleEllipsis')"
        icon="i-lucide-user-plus"
        size="xs"
        color="neutral"
        variant="outline"
        @click="bulkAction = 'add'"
      />
      <UButton
        :label="t('users.roleMembers.removeFrom', { role: roleName })"
        icon="i-lucide-user-minus"
        size="xs"
        color="error"
        variant="outline"
        :loading="bulkBusy && bulkAction === null"
        @click="runBulk('remove')"
      />
      <UButton
        :label="t('users.common.clearSelection')"
        size="xs"
        color="neutral"
        variant="ghost"
        @click="checked = new Set()"
      />
    </div>
    <ul
      v-if="!loadError && members.length > 0"
      class="divide-y divide-default rounded-lg border border-default"
    >
      <li
        v-for="user in members"
        :key="user.id"
        class="flex items-center justify-between gap-3 px-3 py-2"
      >
        <UCheckbox
          :model-value="checked.has(user.id)"
          :disabled="removeLocked(user)"
          :aria-label="t('users.common.selectUser', { user: user.name || user.email })"
          @update:model-value="(v: boolean | 'indeterminate') => toggleChecked(user.id, v === true)"
        />
        <UUser
          :name="user.name || user.email || user.id"
          :description="user.name ? (user.email ?? undefined) : undefined"
          :avatar="{ alt: user.name || user.email || user.id }"
          :to="`/users/${user.id}`"
          size="sm"
          class="min-w-0"
        />
        <span class="ms-auto shrink-0 text-xs text-muted">{{ t('users.roleMembers.lastSignIn', { date: formatDate(user.lastLoginAt) }) }}</span>
        <UPopover
          v-if="!adminRole && !locked"
          :open="expiryUser === user.id"
          @update:open="(open: boolean) => open ? openExpiry(user.id) : (expiryUser = null)"
        >
          <UButton
            icon="i-lucide-calendar-clock"
            :label="expiries.get(user.id) ? t('users.roleMembers.expires', { date: formatDate(expiries.get(user.id)!) }) : undefined"
            :color="expiries.get(user.id) ? 'warning' : 'neutral'"
            variant="ghost"
            size="sm"
            :aria-label="t('users.roleMembers.setExpiry', { user: user.name || user.email })"
          />
          <template #content>
            <div class="flex w-64 flex-col gap-3 p-3">
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
              <div class="flex justify-end gap-2">
                <UButton
                  v-if="expiries.get(user.id)"
                  :label="t('users.roleMembers.expiryClear')"
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  :disabled="savingExpiry"
                  @click="saveExpiry(true)"
                />
                <UButton
                  :label="t('common.save')"
                  size="sm"
                  :loading="savingExpiry"
                  :disabled="!expiryDate"
                  @click="saveExpiry(false)"
                />
              </div>
            </div>
          </template>
        </UPopover>
        <UTooltip
          :text="removeLocked(user) ? (locked ? t('users.roleMembers.systemRole') : t('users.roleMembers.ownerKeeps')) : t('users.roleMembers.removeFrom', { role: roleName })"
        >
          <UButton
            icon="i-lucide-user-minus"
            color="neutral"
            variant="ghost"
            size="sm"
            :aria-label="t('users.roleDelegated.removeLabel', { user: user.name || user.email, role: roleName })"
            :disabled="removeLocked(user) || (removingId !== null && removingId !== user.id)"
            :loading="removingId === user.id"
            @click="removeMember(user)"
          />
        </UTooltip>
      </li>
    </ul>

    <div
      v-if="members.length < total"
      class="flex justify-center"
    >
      <UButton
        :label="t('users.roleDelegated.loadMore')"
        color="neutral"
        variant="outline"
        :loading="loading"
        @click="loadMembers(false)"
      />
    </div>

    <section class="mt-4 flex flex-col gap-2">
      <div class="text-xs font-medium uppercase tracking-wide text-muted">
        {{ t('users.roleMembers.accessHistory') }}
      </div>
      <UEmpty
        v-if="!historyLoading && history.length === 0"
        variant="naked"
        size="sm"
        icon="i-lucide-history"
        :title="t('users.roleMembers.noHistory')"
      />
      <ul
        v-else
        class="divide-y divide-default rounded-lg border border-default"
      >
        <li
          v-for="entry in history"
          :key="entry.id"
          class="flex items-center gap-3 px-3 py-2 text-sm"
        >
          <UIcon
            :name="wasAdded(entry) ? 'i-lucide-user-plus' : 'i-lucide-user-minus'"
            class="size-4 shrink-0"
            :class="entry.status === 'EXECUTED' ? 'text-muted' : 'text-error'"
          />
          <i18n-t
            :keypath="historyKey(entry)"
            tag="span"
            class="min-w-0 flex-1 truncate"
          >
            <template #actor>
              <span class="font-medium">{{ directory.label(entry.principalId, t('users.common.someone')) }}</span>
            </template>
            <template #user>
              <span class="font-medium">{{ directory.label(changedUser(entry)) }}</span>
            </template>
          </i18n-t>
          <span class="shrink-0 text-xs text-muted">{{ formatDate(entry.createdAt) }}</span>
        </li>
      </ul>
      <div
        v-if="history.length < historyTotal"
        class="flex justify-center"
      >
        <UButton
          :label="t('users.roleMembers.olderChanges')"
          color="neutral"
          variant="ghost"
          size="sm"
          :loading="historyLoading"
          @click="loadHistory(true)"
        />
      </div>
    </section>

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
      v-model:open="bulkOpen"
      :title="bulkAction === 'move' ? t('users.roleMembers.moveToRole') : t('users.roleMembers.addAnotherRole')"
      :description="bulkAction === 'move' ? t('users.roleMembers.moveDescription', { n: checked.size, role: roleName }) : t('users.roleMembers.addDescription', { n: checked.size, role: roleName })"
      :confirm-label="bulkAction === 'move' ? t('users.roleMembers.move') : t('common.add')"
      :exclude-role-ids="[roleId]"
      :loading="bulkBusy"
      @pick="(other: string) => runBulk(bulkAction!, other)"
    />
  </div>
</template>
