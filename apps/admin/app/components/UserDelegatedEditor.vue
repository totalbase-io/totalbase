<script setup lang="ts">
/**
 * A user's page for a delegated user (pages/users/[id].vue;
 * Security.md §9.3, §9.4): name and status through the
 * Data API, the roles they may assign through users_roles, and
 * invitation / password reset emails through /app/api/users. The server
 * decides every write (an administrator's account is never theirs to
 * change); this only hides what their grants rule out.
 */
import { useApiErrorMessage } from '~/utils/api-error-message'

const props = defineProps<{ userId: string }>()

const session = useSession()
const dataApi = useDataApi()
const appApi = useAppApi()
const toast = useToast()
const { t } = useI18n()
const errorMessage = useApiErrorMessage()
const notifyError = useErrorToast()
const { data: roles } = useRoleOptions()

interface UserRow {
  id: string
  name?: string | null
  email?: string | null
  avatar_url?: string | null
  active?: boolean
}

const usersPath = dataApi.resourcePath('totalbase', 'users')
const assignmentsPath = dataApi.resourcePath('totalbase', 'users_roles')

const { data: user, pending, error, refresh } = await useAsyncData(`user-data-${props.userId}`, async () =>
  (await dataApi.get<UserRow[]>(usersPath, { 'where[id][_eq]': props.userId, 'limit': 1 })).data[0] ?? null)

const canUpdate = computed(() => session.can('users', 'UPDATE'))
const canDelete = computed(() => session.can('users', 'DELETE'))
const canSeeRoles = computed(() => session.can('assignments', 'READ'))

// --- Profile: name and status, each only when granted. ---
const draftName = ref('')
watch(user, (value) => {
  draftName.value = value?.name ?? ''
}, { immediate: true })
const nameDirty = computed(() => user.value?.name !== undefined && draftName.value.trim() !== (user.value.name ?? ''))
const saving = ref(false)
async function save(patch: Partial<Pick<UserRow, 'name' | 'active'>>, done: string) {
  saving.value = true
  try {
    await dataApi.patch(`${usersPath}/${props.userId}`, { data: patch })
    toast.add({ title: done, color: 'success' })
    await Promise.all([refresh(), refreshUsersData()])
  } catch (err) {
    notifyError(err, t('users.userDelegated.updateError'))
  } finally {
    saving.value = false
  }
}

// --- Links: emailed to the user's own address. ---
async function sendLink(action: 'invite' | 'reset-password', done: string) {
  try {
    await appApi.post(`/users/${props.userId}/${action}`)
    toast.add({ title: done, color: 'success' })
  } catch (err) {
    notifyError(err, t('users.userDelegated.sendError'))
  }
}

// --- Delete ---
const deleteOpen = ref(false)
const deleteConfirmed = ref(false)
const deleting = ref(false)
watch(deleteOpen, (isOpen) => {
  if (isOpen) deleteConfirmed.value = false
})
async function deleteUser() {
  deleting.value = true
  try {
    // Its own endpoint: the avatar leaves storage too (routes/app-users.ts).
    await appApi.del(`/users/${props.userId}`)
    deleteOpen.value = false
    toast.add({ title: t('users.userEditor.deleted'), color: 'success' })
    await refreshUsersData()
    await navigateTo('/users')
  } catch (err) {
    notifyError(err, t('users.userDelegated.deleteError'))
  } finally {
    deleting.value = false
  }
}

const menuItems = computed(() => [
  ...(canUpdate.value && user.value?.email
    ? [[
        { label: t('users.userEditor.menu.sendInvite'), icon: 'i-lucide-send', onSelect: () => sendLink('invite', t('users.userEditor.menu.inviteSent')) },
        { label: t('users.userEditor.menu.sendReset'), icon: 'i-lucide-key', onSelect: () => sendLink('reset-password', t('users.userEditor.menu.resetSent')) }
      ]]
    : []),
  ...(canDelete.value ? [[{ label: t('common.deleteEllipsis'), icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => { deleteOpen.value = true } }]] : [])
])

// --- Roles: the user's assignments; add or remove only what the caller may assign. ---
const assignments = ref<Array<{ id: string, role: string }>>([])
const rolesError = ref<string | null>(null)
async function loadAssignments() {
  if (!canSeeRoles.value) return
  try {
    assignments.value = (await dataApi.get<Array<{ id: string, role: string }>>(assignmentsPath, {
      'where[user][_eq]': props.userId,
      'fields': 'id,role',
      'limit': 500
    })).data
    rolesError.value = null
  } catch (err) {
    rolesError.value = errorMessage(err, t('users.dataviewRoles.loadError'))
  }
}
onMounted(loadAssignments)

const roleName = (id: string) => roles.value?.find(role => role.id === id)?.name ?? t('common.role')
const addableRoles = computed(() => (roles.value ?? [])
  .filter(role => session.canAssign(role.id, 'CREATE') && !assignments.value.some(a => a.role === role.id))
  .map(role => ({ label: role.name, value: role.id })))
const addSelection = ref<string | undefined>(undefined)
const changingRoles = ref(false)
async function addRole(roleId: string | undefined) {
  if (!roleId) return
  changingRoles.value = true
  try {
    await dataApi.post(assignmentsPath, { data: { user: props.userId, role: roleId } })
    await loadAssignments()
  } catch (err) {
    notifyError(err, t('users.roleDelegated.addError'))
  } finally {
    changingRoles.value = false
    addSelection.value = undefined
  }
}
async function removeRole(assignmentId: string) {
  changingRoles.value = true
  try {
    await dataApi.del(`${assignmentsPath}/${assignmentId}`)
    await loadAssignments()
  } catch (err) {
    notifyError(err, t('users.roleDelegated.removeError'))
  } finally {
    changingRoles.value = false
  }
}
</script>

<template>
  <PageShell>
    <template #header>
      <PageHeader
        :title="user?.name || user?.email || t('common.user')"
        :description="user?.name ? (user?.email ?? undefined) : undefined"
        icon="i-lucide-user"
        :avatar="user?.avatar_url"
        height="editor"
        :menu="user ? menuItems : undefined"
      >
        <UButton
          v-if="canUpdate && nameDirty"
          :label="t('common.save')"
          :loading="saving"
          @click="save({ name: draftName.trim() }, t('users.userDelegated.updated'))"
        />
      </PageHeader>
    </template>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="errorMessage(error, t('users.userDelegated.loadError'))"
    />
    <UEmpty
      v-else-if="pending"
      loading
      variant="naked"
      size="sm"
    />
    <p
      v-else-if="!user"
      class="py-12 text-center text-sm text-muted"
    >
      {{ t('users.userDelegated.notFound') }}
    </p>
    <div
      v-else
      class="mx-auto flex w-full max-w-2xl flex-col gap-6 pt-4"
    >
      <section class="flex flex-col gap-4">
        <UFormField
          v-if="user.name !== undefined"
          :label="t('common.name')"
        >
          <UInput
            v-model="draftName"
            :disabled="!canUpdate"
            class="w-full"
          />
        </UFormField>
        <UFormField
          v-if="user.email !== undefined"
          :label="t('users.userEditor.email.label')"
        >
          <UInput
            :model-value="user.email ?? ''"
            disabled
            class="w-full"
          />
        </UFormField>
        <UFormField
          v-if="user.active !== undefined"
          :label="t('common.status')"
          :description="user.active ? t('users.userDelegated.canSignIn') : t('users.userDelegated.deactivated')"
        >
          <USwitch
            :model-value="user.active"
            :disabled="!canUpdate || saving"
            :label="user.active ? t('users.status.ACTIVE') : t('users.status.INACTIVE')"
            @update:model-value="(value: boolean) => save({ active: value }, value ? t('users.userDelegated.activated') : t('users.userDelegated.deactivatedToast'))"
          />
        </UFormField>
      </section>

      <section
        v-if="canSeeRoles"
        class="flex flex-col gap-2"
      >
        <div class="text-xs font-medium uppercase tracking-wide text-muted">
          {{ t('common.roles') }}
        </div>
        <UAlert
          v-if="rolesError"
          color="error"
          variant="subtle"
          :title="rolesError"
        />
        <p
          v-else-if="assignments.length === 0"
          class="text-sm text-muted"
        >
          {{ t('users.userDelegated.noRoles') }}
        </p>
        <ul
          v-else
          class="divide-y divide-default rounded-lg border border-default"
        >
          <li
            v-for="assignment in assignments"
            :key="assignment.id"
            class="flex items-center justify-between gap-3 px-3 py-2 text-sm"
          >
            <span class="truncate">{{ roleName(assignment.role) }}</span>
            <UButton
              v-if="session.canAssign(assignment.role, 'DELETE')"
              icon="i-lucide-x"
              color="neutral"
              variant="ghost"
              size="sm"
              :aria-label="t('users.permissionEditor.removeNamed', { name: roleName(assignment.role) })"
              :disabled="changingRoles"
              @click="removeRole(assignment.id)"
            />
          </li>
        </ul>
        <USelect
          v-if="addableRoles.length > 0"
          v-model="addSelection"
          :aria-label="t('users.userDelegated.addRole')"
          :items="addableRoles"
          :loading="changingRoles"
          :placeholder="t('users.userDelegated.addRole')"
          class="w-full"
          @update:model-value="(value: string) => addRole(value)"
        />
      </section>
    </div>

    <UModal
      v-model:open="deleteOpen"
      :title="t('users.userEditor.deleteTitle')"
    >
      <template #body>
        <i18n-t
          keypath="users.userDelegated.deleteBody"
          tag="p"
          class="text-sm text-muted"
        >
          <template #user>
            <span class="font-medium text-default">{{ user?.name || user?.email }}</span>
          </template>
        </i18n-t>
      </template>
      <template #footer>
        <div class="flex w-full items-center justify-between gap-2">
          <UCheckbox
            v-model="deleteConfirmed"
            :label="t('common.confirm')"
          />
          <div class="flex gap-2">
            <UButton
              :label="t('common.cancel')"
              color="neutral"
              variant="ghost"
              :disabled="deleting"
              @click="deleteOpen = false"
            />
            <UButton
              :label="t('common.delete')"
              color="error"
              :loading="deleting"
              :disabled="!deleteConfirmed"
              @click="deleteUser"
            />
          </div>
        </div>
      </template>
    </UModal>
  </PageShell>
</template>
