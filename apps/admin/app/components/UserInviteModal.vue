<script setup lang="ts">
/**
 * Invite - the passwordless path: creates the account with no password
 * and immediately sends the invite email, so the person sets their own
 * password via the link (POST /users, then POST /users/:id/invite).
 * Roles are required - a brand-new invitee has no access until this picks
 * some, and they can't grant it to themselves.
 *
 * Shared by the Users panel and a role's Users tab - with `roleId` set,
 * the roles are fixed to that one role instead of picked from a list.
 *
 * A delegated user invites through POST /app/api/users/invitations (one
 * call: account, roles, email), choosing among the roles they may assign.
 */
import type { AdminUser } from '~/types/security'
import { useApiErrorMessage } from '~/utils/api-error-message'

const props = defineProps<{ roleId?: string }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ created: [AdminUser] }>()

const api = useAdminApi()
const appApi = useAppApi()
const session = useSession()
const toast = useToast()
const { t } = useI18n()
const errorMessage = useApiErrorMessage()
const notifyError = useErrorToast()
const { reportSendFailure } = useUserLinks()
const { data: allRoles } = useRoleOptions()
const isAdmin = computed(() => session.access.value === 'ADMIN')
const roleOptions = computed(() => isAdmin.value
  ? allRoles.value ?? []
  : (allRoles.value ?? []).filter(role => session.canAssign(role.id, 'CREATE')))

const email = ref('')
const name = ref('')
const roleIds = ref<string[]>([])

// The columns the project added to users (Additional data) - set right after the account exists.
const extraApi = useUserExtraColumns()
// A delegated user sees the ones their grant lets them set - sent with the invitation, so a row filter on
// them (branch = $USER.branch) holds on the new account.
const { data: extraColumns } = useAsyncData('user-extra-columns', () => (isAdmin.value ? extraApi.load() : extraApi.loadInvitable()), { default: () => [] })
const extra = ref<Record<string, unknown>>({})
async function writeExtra(userId: string) {
  const refused = await extraApi.write(userId, extra.value)
  if (refused) toast.add({ title: t('users.userEditor.extra.notSet'), description: errorMessage(refused), color: 'warning' })
}
const inviting = ref(false)

watch(open, (isOpen) => {
  if (!isOpen) return
  email.value = ''
  name.value = ''
  roleIds.value = []
  extra.value = {}
}, { immediate: true })

// Name, email (the invitation goes to it) and at least one role.
// A delegated user who may assign no role invites without one.
const rolesRequired = computed(() => !props.roleId && roleOptions.value.length > 0)
const canInvite = computed(() => !!name.value.trim() && !!email.value.trim() && (!rolesRequired.value || roleIds.value.length > 0))

async function submitDelegated() {
  inviting.value = true
  try {
    const { data: user, meta } = await appApi.post<AdminUser>('/users/invitations', {
      data: {
        email: email.value,
        name: name.value,
        roles: props.roleId ? [props.roleId] : roleIds.value,
        extra: Object.fromEntries(Object.entries(extra.value).filter(([, v]) => v !== undefined && v !== '' && v !== null))
      }
    })
    if (meta?.delivered === false) {
      const error = meta.error as { message?: string } | undefined
      toast.add({ title: t('users.userInvite.notSent'), description: error?.message, color: 'warning' })
    } else {
      toast.add({ title: t('users.userEditor.menu.inviteSent'), color: 'success' })
    }
    open.value = false
    emit('created', user)
  } catch (err) {
    notifyError(err, t('users.userInvite.inviteError'))
  } finally {
    inviting.value = false
  }
}

async function submit() {
  if (!canInvite.value) return
  if (!isAdmin.value) return submitDelegated()
  const roles = props.roleId ? [props.roleId] : roleIds.value
  inviting.value = true
  let user: AdminUser
  try {
    ({ data: user } = await api.post<AdminUser>('/users', {
      data: { email: email.value, name: name.value, roleIds: roles }
    }))
  } catch (err) {
    notifyError(err, t('users.userCreate.createError'))
    inviting.value = false
    return
  }
  await writeExtra(user.id)
  // Two calls, not one: the account already exists once the first one
  // succeeds, so a failed email (e.g. SMTP not configured) must not read
  // as "nothing happened" - retrying here would only hit a duplicate
  // email. Close and hand the new user over either way; the invitation
  // can be re-sent from the user's page.
  try {
    await api.post(`/users/${user.id}/invite`)
    toast.add({ title: t('users.userEditor.menu.inviteSent'), color: 'success' })
  } catch (err) {
    reportSendFailure(err, user.id, 'invite', t('users.userInvite.notSent'))
  } finally {
    inviting.value = false
  }
  open.value = false
  emit('created', user)
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('users.userInvite.title')"
    :description="t('users.userInvite.description')"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <UFormField
          :label="t('common.name')"
          required
        >
          <UInput
            v-model="name"
            class="w-full"
          />
        </UFormField>
        <UFormField
          :label="t('users.userEditor.email.label')"
          required
        >
          <UInput
            v-model="email"
            type="email"
            class="w-full"
          />
        </UFormField>
        <UFormField
          v-if="rolesRequired"
          :label="t('common.roles')"
          required
          :description="t('users.userInvite.rolesHelp')"
        >
          <USelect
            v-model="roleIds"
            :items="roleOptions.map(r => ({ label: r.name, value: r.id }))"
            multiple
            class="w-full"
          />
        </UFormField>
        <template v-if="extraColumns.length">
          <USeparator :label="t('users.userEditor.extra.title')" />
          <UserExtraFields
            v-model="extra"
            :columns="extraColumns"
          />
        </template>
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton
          :label="t('common.cancel')"
          color="neutral"
          variant="ghost"
          :disabled="inviting"
          @click="open = false"
        />
        <UButton
          :label="t('users.userEditor.menu.sendInvite')"
          :loading="inviting"
          :disabled="!canInvite"
          @click="submit"
        />
      </div>
    </template>
  </UModal>
</template>
