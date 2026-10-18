<script setup lang="ts">
/**
 * One user's own page - reached from the Users table (pages/users/
 * index.vue). Profile and Roles are edited here and saved together from
 * the header (same Save + "Unsaved" badge shape as the Templates editor);
 * Permissions, Tokens, Sessions and Activity are that user's slice of the
 * global views (the effective permissions union, TokensTable/SessionsTable
 * with `userId`, the audit log). Its sections sit in the page's toolbar, in
 * the format of a DataView's and a Dashboard's settings (a horizontal
 * UNavigationMenu, each section its own URL, `?section=`); each renders in
 * the body as its own nested PageShell, so a section's table scrolls on its
 * own and its pager sits at the page's foot.
 */
import { USER_STATUS_META, isSystemUser, isWorkflowsRole, userStatus, type AdminUserListItem } from '~/types/security'
import type { Role } from '~/types/permission'
import { useApiErrorMessage } from '~/utils/api-error-message'
// Absolute dates/times in the user's zone and format (My account > Preferences).
const dates = useDateTimeFormat()

const route = useRoute()
const userId = route.params.id as string
const api = useAdminApi()
const dataApi = useDataApi()
const toast = useToast()
const { t } = useI18n()
const errorMessage = useApiErrorMessage()
const notifyError = useErrorToast()
const { copyLink, reportSendFailure } = useUserLinks()

const { data: user, error, refresh } = await useAsyncData(
  `user-${userId}`,
  () => api.get<AdminUserListItem>(`/users/${userId}`).then(r => r.data)
)
const { data: roles } = await useRoles()

const status = computed(() => user.value ? userStatus(user.value) : 'ACTIVE')
const systemUser = computed(() => user.value ? isSystemUser(user.value) : false)

// --- Sections, each its own URL (?section=) ---
const SECTIONS = computed(() => [
  { label: t('users.userEditor.tabs.profile'), value: 'profile', icon: 'i-lucide-user' },
  { label: t('common.roles'), value: 'roles', icon: 'i-lucide-shield' },
  { label: t('users.roleEditor.tabs.permissions'), value: 'permissions', icon: 'i-lucide-list-checks' },
  { label: t('users.userEditor.tabs.tokens'), value: 'tokens', icon: 'i-lucide-key-round' },
  { label: t('users.pages.sessions.title'), value: 'sessions', icon: 'i-lucide-monitor-smartphone' },
  { label: t('users.userEditor.tabs.activity'), value: 'activity', icon: 'i-lucide-history' }
])
const tab = computed(() => SECTIONS.value.some(item => item.value === route.query.section) ? route.query.section as string : 'profile')
const sectionItems = computed(() => SECTIONS.value.map(item => ({
  label: item.label,
  icon: item.icon,
  to: { query: { ...route.query, section: item.value === 'profile' ? undefined : item.value } },
  active: tab.value === item.value
})))

// --- Draft: name + roles, saved together from the header. The email is
// not part of it - changing it is its own dialog (below). ---
const draftName = ref('')
const draftRoles = ref<string[]>([])
function resetDraft() {
  draftName.value = user.value?.name ?? ''
  draftRoles.value = [...(user.value?.roles ?? [])]
}
watch(user, resetDraft, { immediate: true })

/** Reloads the user after an action applied at once (email, avatar, password) - any unsaved name/roles edit survives. */
async function reloadUser() {
  const keep = { name: draftName.value, roles: [...draftRoles.value] }
  await Promise.all([refresh(), refreshUsersData()])
  draftName.value = keep.name
  draftRoles.value = keep.roles
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(id => b.includes(id))
const nameDirty = computed(() => !!user.value && draftName.value.trim() !== (user.value.name ?? ''))
const rolesDirty = computed(() => !!user.value && !sameSet(draftRoles.value, user.value.roles))
// --- Additional data: the columns the project added to users (AGENTS.md §11) - read and saved through
// the Data API with the header's Save, one write each so PostgreSQL's refusal shows under its column. ---
const { load: loadExtraColumns } = useUserExtraColumns()
const { data: extraColumns } = await useAsyncData(`user-extra-columns`, () => loadExtraColumns(), { default: () => [] })
const savedExtra = ref<Record<string, unknown>>({})
const draftExtra = ref<Record<string, unknown>>({})
const extraErrors = ref<Record<string, string>>({})
async function loadExtra() {
  if (!extraColumns.value.length) return
  const { data } = await dataApi.get<Record<string, unknown>>(dataApi.resourcePath('totalbase', 'users', 'table', userId), { fields: extraColumns.value.map(c => c.name).join(',') })
  savedExtra.value = { ...data }
  draftExtra.value = { ...data }
  extraErrors.value = {}
}
watch(extraColumns, () => void loadExtra(), { immediate: true })
const changedExtra = computed(() => extraColumns.value.map(c => c.name).filter(name => JSON.stringify(draftExtra.value[name] ?? null) !== JSON.stringify(savedExtra.value[name] ?? null)))
const dirty = computed(() => nameDirty.value || rolesDirty.value || changedExtra.value.length > 0)

// A role the admin can't toggle here: the system-only Workflows role
// (locked to its seeded account server-side), and the Administrators role
// on the instance owner, who can never lose it.
function roleLocked(role: Role): string | null {
  if (systemUser.value) return t('users.userEditor.roleLocked.system')
  if (isWorkflowsRole(role)) return t('users.userEditor.roleLocked.workflows')
  if (role.reserved && user.value?.owner) return t('users.userEditor.roleLocked.owner')
  return null
}
const sortedRoles = computed(() => [...(roles.value ?? [])]
  .filter(r => !isWorkflowsRole(r) || user.value?.roles.includes(r.id))
  .sort((a, b) => Number(b.reserved) - Number(a.reserved) || a.name.localeCompare(b.name)))

// The access flags the checked (active) roles add up to - OR across roles,
// the same rule the server applies (RolesService.effectiveAccess).
const draftAccess = computed(() => {
  const checked = (roles.value ?? []).filter(r => r.active && draftRoles.value.includes(r.id))
  return {
    adminAccess: checked.some(r => r.adminAccess),
    appAccess: checked.some(r => r.appAccess),
    apiAccess: checked.some(r => r.apiAccess)
  }
})
const draftHasAccess = computed(() => draftAccess.value.adminAccess || draftAccess.value.appAccess || draftAccess.value.apiAccess)

function toggleRole(roleId: string, checked: boolean) {
  draftRoles.value = checked
    ? [...new Set([...draftRoles.value, roleId])]
    : draftRoles.value.filter(id => id !== roleId)
}

// --- Avatar: applied at once, not by the header's Save (user-avatars.ts
// on the server re-encodes, stores it in Files and cleans up the old one).
const avatarInput = ref<HTMLInputElement | null>(null)
const avatarBusy = ref<'upload' | 'provider' | 'remove' | null>(null)

async function avatarAction(kind: 'upload' | 'provider' | 'remove', run: () => Promise<unknown>, failure: string) {
  avatarBusy.value = kind
  try {
    await run()
    await reloadUser()
  } catch (err) {
    notifyError(err, failure)
  } finally {
    avatarBusy.value = null
  }
}

function onAvatarPicked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const form = new FormData()
  form.append('file', file)
  void avatarAction('upload', () => api.post(`/users/${userId}/avatar`, form), t('users.userEditor.avatar.uploadError'))
}

function useProviderAvatar() {
  void avatarAction('provider', () => api.post(`/users/${userId}/avatar/provider`), t('users.userEditor.avatar.providerError'))
}

function removeAvatar() {
  void avatarAction('remove', () => api.del(`/users/${userId}/avatar`), t('users.userEditor.avatar.removeError'))
}

// --- Change email: a sensitive step of its own, applied at once (not by
// the header's Save) - PUT /users/:id/email, which also retires the links
// sent to the old address. The admin picks how the new one is verified.
const emailOpen = ref(false)
const newEmail = ref('')
const emailVerification = ref<'SEND' | 'VERIFIED'>('SEND')
const changingEmail = ref(false)
const emailVerificationItems = computed(() => [
  { value: 'SEND', label: t('users.userEditor.email.send'), description: t('users.userEditor.email.sendHelp') },
  { value: 'VERIFIED', label: t('users.userEditor.email.verified'), description: t('users.userEditor.email.verifiedHelp') }
])
const newEmailValid = computed(() => /^[^\s@]+@[^\s@]+$/.test(newEmail.value.trim())
  && newEmail.value.trim().toLowerCase() !== (user.value?.email ?? '').toLowerCase())

function openEmailChange() {
  newEmail.value = ''
  emailVerification.value = 'SEND'
  emailOpen.value = true
}

async function changeEmail() {
  if (!newEmailValid.value) return
  changingEmail.value = true
  try {
    const { meta } = await api.put(`/users/${userId}/email`, { data: { email: newEmail.value.trim(), verification: emailVerification.value } })
    emailOpen.value = false
    await reloadUser()
    if (meta?.verificationError) {
      toast.add({ title: t('users.userEditor.email.changedNotSent'), description: String(meta.verificationError), color: 'warning' })
    } else {
      toast.add({ title: t('users.userEditor.email.changed'), description: meta?.verificationSent ? t('users.userEditor.email.verificationSent') : undefined, color: 'success' })
    }
  } catch (err) {
    notifyError(err, t('users.userEditor.email.changeError'))
  } finally {
    changingEmail.value = false
  }
}

const saving = ref(false)
async function save() {
  if (!user.value || !dirty.value) return
  if (nameDirty.value && !draftName.value.trim()) {
    toast.add({ title: t('users.userEditor.nameRequired'), color: 'error' })
    return
  }
  saving.value = true
  try {
    if (nameDirty.value) await dataApi.patch(dataApi.resourcePath('totalbase', 'users', 'table', userId), { data: { name: draftName.value.trim() } })
    if (rolesDirty.value) await api.put(`/users/${userId}/roles`, { data: { roleIds: draftRoles.value } })
    // Each additional column on its own: a refusal stays under its field, the others still save.
    const refused: Record<string, string> = {}
    for (const name of changedExtra.value) {
      try {
        await dataApi.patch(dataApi.resourcePath('totalbase', 'users', 'table', userId), { data: { [name]: draftExtra.value[name] ?? null } })
        savedExtra.value = { ...savedExtra.value, [name]: draftExtra.value[name] ?? null }
      } catch (err) {
        refused[name] = errorMessage(err)
      }
    }
    extraErrors.value = refused
    await Promise.all([refresh(), refreshUsersData()])
    if (Object.keys(refused).length > 0) {
      toast.add({ title: t('users.userEditor.extra.saveError'), color: 'error' })
      return
    }
    toast.add({ title: t('users.userEditor.saved'), color: 'success' })
  } catch (err) {
    notifyError(err, t('users.userEditor.saveError'))
  } finally {
    saving.value = false
  }
}

// --- Actions on the user itself (the header's "⋯" menu) ---
const actionLoading = ref(false)
// Revoking every open session is a plain row update (Specification_Security.md §10):
// the Data API, where PostgreSQL stamps the time.
async function runAction(path: 'invite' | 'reset-password' | 'revoke-sessions', successTitle: string, failureTitle: string) {
  actionLoading.value = true
  try {
    if (path === 'revoke-sessions') {
      await dataApi.patch(dataApi.resourcePath('totalbase', 'sessions'), { data: { revoked_at: new Date().toISOString() } }, { 'where[user][_eq]': userId, 'where[revoked_at][_null]': true })
    } else {
      await api.post(`/users/${userId}/${path}`)
    }
    toast.add({ title: successTitle, color: 'success' })
    if (path === 'revoke-sessions') await refreshNuxtData(['sessions', `sessions-${userId}`])
  } catch (err) {
    if (path === 'revoke-sessions') {
      notifyError(err, failureTitle)
    } else {
      reportSendFailure(err, userId, path, failureTitle)
    }
  } finally {
    actionLoading.value = false
  }
}

// Ends a lockout (too many failed sign-ins) before it expires.
async function unlock() {
  actionLoading.value = true
  try {
    await dataApi.patch(dataApi.resourcePath('totalbase', 'users', 'table', userId), { data: { locked_until: null, failed_login_count: 0 } })
    toast.add({ title: t('users.userEditor.unlocked'), color: 'success' })
    await Promise.all([refresh(), refreshUsersData()])
  } catch (err) {
    notifyError(err, t('users.userEditor.unlockError'))
  } finally {
    actionLoading.value = false
  }
}

async function toggleActive() {
  if (!user.value) return
  actionLoading.value = true
  try {
    await dataApi.patch(dataApi.resourcePath('totalbase', 'users', 'table', userId), { data: { active: !user.value.active } })
    await Promise.all([refresh(), refreshUsersData()])
  } catch (err) {
    notifyError(err, t('users.userEditor.updateError'))
  } finally {
    actionLoading.value = false
  }
}

const menuItems = computed(() => {
  const u = user.value
  if (!u) return []
  const canEmail = !!u.email && u.canLogin
  return [
    [
      ...(u.hasPassword
        ? [
            { label: t('users.userEditor.menu.sendReset'), icon: 'i-lucide-key', disabled: !canEmail, onSelect: () => runAction('reset-password', t('users.userEditor.menu.resetSent'), t('users.userEditor.menu.resetError')) },
            { label: t('users.userEditor.menu.copyReset'), icon: 'i-lucide-link', disabled: !canEmail, onSelect: () => copyLink(userId, 'reset-password') }
          ]
        : [
            { label: t('users.userEditor.menu.sendInvite'), icon: 'i-lucide-send', disabled: !canEmail, onSelect: () => runAction('invite', t('users.userEditor.menu.inviteSent'), t('users.userEditor.menu.inviteError')) },
            { label: t('users.userEditor.menu.copyInvite'), icon: 'i-lucide-link', disabled: !canEmail, onSelect: () => copyLink(userId, 'invite') }
          ]),
      { label: t('users.userEditor.menu.revokeSessions'), icon: 'i-lucide-log-out', onSelect: () => runAction('revoke-sessions', t('users.userEditor.menu.sessionsRevoked'), t('users.userEditor.menu.sessionsError')) },
      ...(u.lockedUntil ? [{ label: t('users.userEditor.menu.unlock'), icon: 'i-lucide-lock-open', onSelect: unlock }] : [])
    ]
    // Deactivate / Delete live in Profile's Danger zone only - one place
    // for the destructive actions.
  ]
})

// --- Danger zone + password: what the signed-in admin can't do to this
// account, and why (the server enforces the same). ---
const session = useSession()
const isSelf = computed(() => session.admin.value?.id === userId)
const protectedReason = computed(() => {
  if (!user.value) return null
  if (systemUser.value) return t('users.userEditor.protected.system')
  if (user.value.owner) return t('users.userEditor.protected.owner')
  if (isSelf.value) return t('users.userEditor.protected.self')
  return null
})
const passwordOpen = ref(false)

const deleteOpen = ref(false)
const deleteConfirmed = ref(false)
const deleting = ref(false)
watch(deleteOpen, (isOpen) => {
  if (isOpen) deleteConfirmed.value = false
})
async function deleteUser() {
  deleting.value = true
  try {
    await api.del(`/users/${userId}`)
    deleteOpen.value = false
    toast.add({ title: t('users.userEditor.deleted'), color: 'success' })
    await refreshUsersData()
    await navigateTo('/users')
  } catch (err) {
    notifyError(err, t('users.userEditor.deleteError'))
  } finally {
    deleting.value = false
  }
}

// --- Unsaved changes guard - same as the Templates editor. ---
const leaveOpen = ref(false)
let pendingLeave: string | null = null
onBeforeRouteLeave((to) => {
  if (!dirty.value || to.path === route.path) return true
  pendingLeave = to.fullPath
  leaveOpen.value = true
  return false
})
async function discardAndLeave() {
  resetDraft()
  draftExtra.value = { ...savedExtra.value }
  extraErrors.value = {}
  leaveOpen.value = false
  if (pendingLeave) await navigateTo(pendingLeave)
}

function formatDate(value: string | null) {
  return value ? dates.dateTime(value) : '—'
}
</script>

<template>
  <PageShell
    flush
    :scroll="false"
  >
    <template
      v-if="user"
      #header
    >
      <PageHeader
        :title="user.name || user.email || t('common.user')"
        :description="user.name ? user.email ?? undefined : undefined"
        icon="i-lucide-user"
        :avatar="user.avatarUrl"
        height="editor"
        :menu="menuItems"
        :menu-loading="actionLoading"
      >
        <!-- On a phone only what needs attention stays: Locked, a status
        other than Active, Unsaved. -->
        <div class="flex items-center gap-2">
          <UBadge
            v-if="user.owner"
            :label="t('users.userEditor.owner')"
            color="warning"
            variant="outline"
            class="page-header__tall px-2.5 max-md:hidden"
          />
          <UBadge
            v-if="systemUser"
            :label="t('users.userEditor.system')"
            color="info"
            variant="outline"
            class="page-header__tall px-2.5 max-md:hidden"
          />
          <UTooltip
            v-if="user.lockedUntil"
            :text="t('users.userEditor.lockedTooltip', { date: formatDate(user.lockedUntil) })"
          >
            <UBadge
              :label="t('users.userEditor.locked')"
              icon="i-lucide-lock"
              color="error"
              variant="subtle"
              class="page-header__tall px-2.5"
            />
          </UTooltip>
          <UBadge
            :label="t(USER_STATUS_META[status].labelKey)"
            :color="USER_STATUS_META[status].color"
            variant="subtle"
            class="page-header__tall px-2.5"
            :class="status === 'ACTIVE' ? 'max-md:hidden' : undefined"
          />
          <UBadge
            v-if="dirty"
            :label="t('users.userEditor.unsaved')"
            color="warning"
            variant="subtle"
            class="page-header__tall px-2.5"
          />
          <UButton
            icon="i-lucide-save"
            :label="t('common.save')"
            :disabled="!dirty"
            :loading="saving"
            @click="save"
          />
        </div>
      </PageHeader>
    </template>
    <template
      v-if="user && !error"
      #toolbar
    >
      <UNavigationMenu
        :items="sectionItems"
        orientation="horizontal"
        highlight
        :aria-label="t('users.userEditor.sectionsNav')"
        :ui="{ item: 'shrink-0' }"
        class="overflow-x-auto"
      />
    </template>
    <UAlert
      v-if="error || !user"
      class="m-4 w-auto sm:m-6"
      color="error"
      variant="subtle"
      :title="t('users.userEditor.loadError')"
      :description="error ? errorMessage(error) : undefined"
    />
    <PageShell v-else-if="tab === 'profile' || tab === 'roles'">
      <!-- Profile - GitHub Settings-style sections: who the user is
      (editable), then how they sign in (read-only facts). Status lives
      in the header. -->
      <div
        v-if="tab === 'profile'"
        class="mx-auto flex w-full max-w-3xl flex-col gap-8"
      >
        <SettingsSection
          :title="t('users.userEditor.tabs.profile')"
        >
          <UFormField
            :label="t('common.name')"
            required
            :description="user.name ? undefined : t('users.userEditor.nameNotSet')"
          >
            <UInput
              v-model="draftName"
              class="w-full"
              @keydown.enter="save"
            />
          </UFormField>
          <UFormField
            :label="t('users.userEditor.email.label')"
            :description="systemUser ? t('users.userEditor.email.systemHelp') : t('users.userEditor.email.help')"
          >
            <div class="flex gap-2">
              <UInput
                :model-value="user.email ?? ''"
                readonly
                class="w-full"
              />
              <UButton
                v-if="!systemUser"
                :label="t('common.edit')"
                icon="i-lucide-pencil"
                color="neutral"
                variant="outline"
                @click="openEmailChange"
              />
            </div>
          </UFormField>
          <UFormField
            :label="t('users.userEditor.avatar.label')"
            :description="t('users.userEditor.avatar.help')"
          >
            <div class="flex flex-wrap items-center gap-3">
              <UAvatar
                :src="user.avatarUrl ?? undefined"
                :alt="user.name || user.email || undefined"
                size="3xl"
              />
              <input
                ref="avatarInput"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                class="hidden"
                @change="onAvatarPicked"
              >
              <UButton
                :label="user.avatarUrl ? t('users.userEditor.avatar.replace') : t('common.upload')"
                icon="i-lucide-upload"
                color="neutral"
                variant="outline"
                :loading="avatarBusy === 'upload'"
                :disabled="!!avatarBusy"
                @click="avatarInput?.click()"
              />
              <UButton
                v-if="user.providerAvatar && user.providerAvatar.url !== user.avatarUrl"
                :label="t('users.userEditor.avatar.useProvider', { provider: user.providerAvatar.provider })"
                icon="i-lucide-user-round-check"
                color="neutral"
                variant="ghost"
                :loading="avatarBusy === 'provider'"
                :disabled="!!avatarBusy"
                @click="useProviderAvatar"
              />
              <UButton
                v-if="user.avatarUrl"
                :label="t('common.remove')"
                icon="i-lucide-trash-2"
                color="error"
                variant="ghost"
                :loading="avatarBusy === 'remove'"
                :disabled="!!avatarBusy"
                @click="removeAvatar"
              />
            </div>
          </UFormField>
        </SettingsSection>

        <SettingsSection
          v-if="extraColumns.length"
          :title="t('users.userEditor.extra.title')"
        >
          <UserExtraFields
            v-model="draftExtra"
            :columns="extraColumns"
            :errors="extraErrors"
          />
        </SettingsSection>

        <SettingsSection
          :title="t('users.userEditor.signIn.title')"
        >
          <dl class="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-3 text-sm">
            <dt class="text-muted">
              {{ t('users.userEditor.signIn.canSignIn') }}
            </dt>
            <dd>{{ user.canLogin ? t('common.yes') : t('users.userEditor.signIn.noSystem') }}</dd>
            <template v-if="user.canLogin">
              <dt class="text-muted">
                {{ t('users.userEditor.signIn.password') }}
              </dt>
              <dd class="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>{{ user.hasPassword ? t('users.userEditor.signIn.passwordSet') : t('users.userEditor.signIn.passwordNotSet') }}</span>
                <UButton
                  :label="isSelf ? t('users.password.changeButton') : t('users.password.setTitle')"
                  icon="i-lucide-key-round"
                  color="neutral"
                  variant="outline"
                  size="xs"
                  @click="passwordOpen = true"
                />
              </dd>
              <dt class="text-muted">
                {{ t('users.userEditor.email.label') }}
              </dt>
              <dd :class="user.emailVerifiedAt ? undefined : 'text-warning'">
                {{ user.emailVerifiedAt ? t('users.userEditor.signIn.verifiedOn', { date: formatDate(user.emailVerifiedAt) }) : t('users.userEditor.signIn.notVerified') }}
              </dd>
              <dt class="text-muted">
                {{ t('users.userEditor.signIn.lastSignIn') }}
              </dt>
              <dd>{{ user.lastLoginAt ? formatDate(user.lastLoginAt) : t('users.common.never') }}</dd>
              <template v-if="user.lockedUntil || user.failedLoginCount > 0">
                <dt class="text-muted">
                  {{ t('users.userEditor.signIn.failed') }}
                </dt>
                <dd :class="user.lockedUntil ? 'text-error' : 'text-warning'">
                  {{ user.lockedUntil
                    ? t('users.userEditor.signIn.lockedUntil', { date: formatDate(user.lockedUntil) })
                    : t('users.userEditor.signIn.failedCount', { n: user.failedLoginCount }) }}
                </dd>
              </template>
            </template>
            <dt class="text-muted">
              {{ t('users.userEditor.signIn.created') }}
            </dt>
            <dd>{{ formatDate(user.createdAt) }}</dd>
            <dt class="text-muted">
              ID
            </dt>
            <dd class="font-mono text-xs">
              {{ user.id }}
            </dd>
          </dl>
        </SettingsSection>

        <!-- Danger zone: one card per destructive action - what it does,
        and its button. Deactivate is reversible (amber), Delete isn't (red). -->
        <section class="flex flex-col gap-3">
          <h2 class="text-base font-semibold text-error">
            {{ t('users.userEditor.danger.title') }}
          </h2>
          <div class="flex flex-col gap-3">
            <div class="flex flex-wrap items-center gap-3 rounded-lg border border-warning/60 bg-warning/20 px-4 py-4">
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium text-highlighted">
                  {{ user.active ? t('users.userEditor.danger.deactivateTitle') : t('users.userEditor.danger.activateTitle') }}
                </p>
                <p class="text-sm text-muted">
                  {{ user.active ? t('users.userEditor.danger.deactivateHelp') : t('users.userEditor.danger.activateHelp') }}
                </p>
              </div>
              <UTooltip
                :text="protectedReason ?? undefined"
                :disabled="!protectedReason"
              >
                <UButton
                  :label="user.active ? t('users.roleEditor.deactivate') : t('users.roleEditor.activate')"
                  :color="user.active ? 'warning' : 'neutral'"
                  variant="outline"
                  :loading="actionLoading"
                  :disabled="!!protectedReason && user.active"
                  @click="toggleActive"
                />
              </UTooltip>
            </div>
            <div class="flex flex-wrap items-center gap-3 rounded-lg border border-error/60 bg-error/20 px-4 py-4">
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium text-highlighted">
                  {{ t('users.userEditor.danger.deleteTitle') }}
                </p>
                <p class="text-sm text-muted">
                  {{ t('users.userEditor.danger.deleteHelp') }}
                </p>
              </div>
              <UTooltip
                :text="protectedReason ?? undefined"
                :disabled="!protectedReason"
              >
                <UButton
                  :label="t('users.userEditor.danger.deleteTitle')"
                  color="error"
                  :disabled="!!protectedReason"
                  @click="deleteOpen = true"
                />
              </UTooltip>
            </div>
          </div>
          <p
            v-if="protectedReason"
            class="text-xs text-muted"
          >
            {{ protectedReason }}
          </p>
        </section>
      </div>

      <!-- Roles -->
      <div
        v-else
        class="mx-auto flex w-full max-w-3xl flex-col gap-3"
      >
        <p class="text-sm text-muted">
          {{ t('users.userEditor.rolesIntro') }}
        </p>
        <!-- What the checked roles add up to, live as boxes are ticked -
        which portals the user can sign in to (inactive roles grant
        nothing, as on the server). -->
        <div
          class="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm"
          :class="draftHasAccess ? 'border-default' : 'border-warning/60 bg-warning/20'"
        >
          <template v-if="draftHasAccess">
            <span class="text-muted">{{ t('users.userEditor.accessFromRoles') }}</span>
            <RoleAccessBadges :role="draftAccess" />
            <UBadge
              v-if="rolesDirty"
              :label="t('users.userEditor.unsaved')"
              color="warning"
              variant="outline"
              size="sm"
            />
          </template>
          <template v-else>
            <UIcon
              name="i-lucide-circle-alert"
              class="size-4 text-warning"
            />
            <span>{{ t('users.userEditor.noAccess') }}</span>
          </template>
        </div>
        <div class="flex flex-col divide-y divide-default rounded-lg border border-default">
          <label
            v-for="role in sortedRoles"
            :key="role.id"
            class="flex items-center gap-3 px-3 py-2.5"
            :class="roleLocked(role) ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-elevated/50'"
          >
            <UCheckbox
              :model-value="draftRoles.includes(role.id)"
              :disabled="!!roleLocked(role)"
              @update:model-value="(v: boolean | 'indeterminate') => toggleRole(role.id, v === true)"
            />
            <RoleBadge :role="role" />
            <div class="flex min-w-0 flex-1 flex-col">
              <span class="flex items-center gap-2 text-sm font-medium">
                {{ role.name }}
                <UBadge
                  v-if="!role.active"
                  :label="t('common.inactive')"
                  color="neutral"
                  variant="subtle"
                  size="sm"
                />
              </span>
              <span class="truncate text-xs text-muted">{{ roleLocked(role) ?? role.description ?? '' }}</span>
            </div>
            <RoleAccessBadges :role="role" />
            <UButton
              icon="i-lucide-arrow-up-right"
              color="neutral"
              variant="ghost"
              size="sm"
              :to="`/roles/${role.id}`"
              :aria-label="t('users.userEditor.openRole')"
              @click.stop
            />
          </label>
        </div>
      </div>
    </PageShell>
    <UserEffectivePermissions
      v-else-if="tab === 'permissions'"
      :user-id="userId"
    />
    <TokensTable
      v-else-if="tab === 'tokens'"
      :user-id="userId"
    />
    <SessionsTable
      v-else-if="tab === 'sessions'"
      :user-id="userId"
    />
    <UserActivity
      v-else
      :user-id="userId"
    />

    <UModal
      v-model:open="deleteOpen"
      :title="t('users.userEditor.deleteTitle')"
      :description="t('users.userEditor.deleteDescription')"
    >
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

    <UserPasswordModal
      v-if="user"
      v-model:open="passwordOpen"
      :user-id="userId"
      :self="isSelf"
      @saved="reloadUser"
    />

    <UModal
      v-model:open="emailOpen"
      :title="t('users.userEditor.email.changeTitle')"
      :description="t('users.userEditor.email.changeDescription', { email: user?.email ?? t('users.userEditor.email.none') })"
    >
      <template #body>
        <form
          id="change-email-form"
          class="flex flex-col gap-5"
          @submit.prevent="changeEmail"
        >
          <UFormField
            :label="t('users.userEditor.email.newEmail')"
            required
          >
            <UInput
              v-model="newEmail"
              type="email"
              autocomplete="off"
              autofocus
              class="w-full"
            />
          </UFormField>
          <UFormField :label="t('users.userEditor.email.verification')">
            <URadioGroup
              v-model="emailVerification"
              :items="emailVerificationItems"
            />
          </UFormField>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="ghost"
            :disabled="changingEmail"
            @click="emailOpen = false"
          />
          <UButton
            type="submit"
            form="change-email-form"
            :label="t('common.save')"
            :loading="changingEmail"
            :disabled="!newEmailValid"
          />
        </div>
      </template>
    </UModal>

    <UModal
      v-model:open="leaveOpen"
      :title="t('users.userEditor.leave.title')"
      :description="t('users.userEditor.leave.description')"
    >
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            :label="t('users.userEditor.leave.keep')"
            color="neutral"
            variant="ghost"
            @click="leaveOpen = false"
          />
          <UButton
            :label="t('users.userEditor.leave.discard')"
            color="error"
            @click="discardAndLeave"
          />
        </div>
      </template>
    </UModal>
  </PageShell>
</template>
