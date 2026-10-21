<script setup lang="ts">
/**
 * My account (Security.md §4) - the signed-in
 * user's own account, for every portal user: opened from the avatar menu
 * of the one portal shell (Security.md §9). Everything
 * goes through /app/api/me (plus the
 * self-service /api/tokens) - never the Admin API, which an app user
 * can't reach.
 *
 * The same tabs as a user's page for an admin (pages/users/[id].vue),
 * minus what only an admin decides (roles, permissions, activation):
 * Profile (name - saved from the header - and email, avatar, password,
 * two-factor authentication, applied at once), Sessions, Tokens (only for a user who can hold one),
 * Preferences, Activity. The open tab lives in `?tab=`.
 */
import type { MyAccount } from '~/types/security'
import { useApiErrorMessage } from '~/utils/api-error-message'

const route = useRoute()
const router = useRouter()
const session = useSession()
const appApi = useAppApi()
const dataApi = useDataApi()
const toast = useToast()
const { dateTime } = useDateTimeFormat()
const { t } = useI18n()
const errorMessage = useApiErrorMessage()
const notifyError = useErrorToast()

const { data: account, error, refresh } = await useAsyncData(
  'account',
  () => appApi.get<MyAccount>('/me').then(r => r.data)
)

/** After a change to what the navbar shows (name, avatar, email). */
async function reload() {
  await Promise.all([refresh(), session.refreshProfile().catch(() => undefined)])
}

// --- Tabs, synced with ?tab= ---
const canHoldTokens = computed(() => !!account.value && (account.value.tokens.api || account.value.tokens.admin))
const tabs = computed(() => [
  { label: t('account.tabs.profile'), value: 'profile', icon: 'i-lucide-user' },
  { label: t('account.tabs.sessions'), value: 'sessions', icon: 'i-lucide-monitor-smartphone' },
  ...(canHoldTokens.value ? [{ label: t('account.tabs.tokens'), value: 'tokens', icon: 'i-lucide-key-round' }] : []),
  { label: t('account.tabs.preferences'), value: 'preferences', icon: 'i-lucide-sliders-horizontal' },
  // One's own activity is a grant like any other (the default permissions give it, Security.md §10.5).
  ...(session.can('logs', 'READ') ? [{ label: t('account.tabs.activity'), value: 'activity', icon: 'i-lucide-history' }] : [])
])
const tab = computed({
  get: () => tabs.value.some(item => item.value === route.query.tab) ? route.query.tab as string : 'profile',
  set: (value: string) => { router.replace({ query: { ...route.query, tab: value === 'profile' ? undefined : value } }) }
})
const activity = useTemplateRef('activity')
const tokenPlanes = computed(() => account.value
  ? (['API', 'ADMIN'] as const).filter(plane => account.value!.tokens[plane === 'API' ? 'api' : 'admin'])
  : [])

// --- Name: saved from the header, like a user's page. ---
const draftName = ref('')
watch(account, (value) => {
  draftName.value = value?.name ?? ''
}, { immediate: true })
const dirty = computed(() => !!account.value && draftName.value.trim() !== (account.value.name ?? ''))
const saving = ref(false)
async function save() {
  if (!dirty.value) return
  if (!draftName.value.trim()) {
    toast.add({ title: t('account.profile.nameRequired'), color: 'error' })
    return
  }
  saving.value = true
  try {
    await appApi.patch('/me', { data: { name: draftName.value.trim() } })
    await reload()
    toast.add({ title: t('account.profile.saved'), color: 'success' })
  } catch (err) {
    notifyError(err, t('account.profile.saveError'))
  } finally {
    saving.value = false
  }
}

// --- Avatar: applied at once (same server handling as the admin's). ---
const avatarInput = ref<HTMLInputElement | null>(null)
const avatarBusy = ref<'upload' | 'provider' | 'remove' | null>(null)
async function avatarAction(kind: 'upload' | 'provider' | 'remove', run: () => Promise<unknown>, failure: string) {
  avatarBusy.value = kind
  try {
    await run()
    await reload()
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
  void avatarAction('upload', () => appApi.post('/me/avatar', form), t('account.profile.avatarUploadError'))
}

// --- Email: its own step, confirmed with the current password; the new
// address stays unverified until the user follows the email. ---
const emailOpen = ref(false)
const newEmail = ref('')
const emailPassword = ref('')
const changingEmail = ref(false)
const newEmailValid = computed(() => /^[^\s@]+@[^\s@]+$/.test(newEmail.value.trim())
  && newEmail.value.trim().toLowerCase() !== (account.value?.email ?? '').toLowerCase()
  && emailPassword.value.length > 0)
function openEmailChange() {
  newEmail.value = ''
  emailPassword.value = ''
  emailOpen.value = true
}
async function changeEmail() {
  if (!newEmailValid.value) return
  changingEmail.value = true
  try {
    const { meta } = await appApi.put('/me/email', { data: { email: newEmail.value.trim(), currentPassword: emailPassword.value } })
    emailOpen.value = false
    await reload()
    if (meta?.verificationError) {
      toast.add({ title: t('account.email.changedNotSent'), description: String(meta.verificationError), color: 'warning' })
    } else {
      toast.add({ title: t('account.email.changed'), description: t('account.email.changedDescription'), color: 'success' })
    }
  } catch (err) {
    notifyError(err, t('account.email.changeError'))
  } finally {
    changingEmail.value = false
  }
}

const resending = ref(false)
async function resendVerification() {
  resending.value = true
  try {
    await dataApi.post('/auth/email/resend')
    toast.add({ title: t('account.email.verificationSent'), color: 'success' })
  } catch (err) {
    notifyError(err, t('account.email.verificationError'))
  } finally {
    resending.value = false
  }
}

const passwordOpen = ref(false)

// --- Unsaved name guard, same as a user's page. ---
const leaveOpen = ref(false)
let pendingLeave: string | null = null
onBeforeRouteLeave((to) => {
  if (!dirty.value || to.path === route.path) return true
  pendingLeave = to.fullPath
  leaveOpen.value = true
  return false
})
async function discardAndLeave() {
  draftName.value = account.value?.name ?? ''
  leaveOpen.value = false
  if (pendingLeave) await navigateTo(pendingLeave)
}
</script>

<template>
  <PageShell
    flush
    :scroll="false"
  >
    <template
      v-if="account"
      #header
    >
      <PageHeader
        :title="account.name || account.email"
        :description="account.name ? account.email : undefined"
        icon="i-lucide-circle-user"
        :avatar="account.avatarUrl"
        height="editor"
      >
        <div class="flex items-center gap-2">
          <UBadge
            v-if="dirty"
            :label="t('common.unsaved')"
            color="warning"
            variant="subtle"
            class="page-header__tall px-2.5"
          />
          <UButton
            v-if="tab === 'profile'"
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
      v-if="account && !error"
      #toolbar
    >
      <UTabs
        v-model="tab"
        :items="tabs"
        variant="link"
        :content="false"
      />
    </template>

    <UAlert
      v-if="error || !account"
      class="m-4 w-auto sm:m-6"
      color="error"
      variant="subtle"
      :title="t('account.loadError')"
      :description="error ? errorMessage(error) : undefined"
    />
    <PageShell v-else-if="tab === 'profile'">
      <div class="mx-auto flex w-full max-w-2xl flex-col gap-8">
        <section class="flex flex-col gap-4">
          <h2 class="border-b border-default pb-2 text-base font-semibold text-highlighted">
            {{ t('account.tabs.profile') }}
          </h2>
          <UFormField
            :label="t('common.name')"
            required
          >
            <UInput
              v-model="draftName"
              class="w-full"
              @keydown.enter="save"
            />
          </UFormField>
          <UFormField
            :label="t('account.profile.email')"
            :description="t('account.profile.emailDescription')"
          >
            <div class="flex gap-2">
              <UInput
                :model-value="account.email"
                readonly
                class="w-full"
              />
              <UButton
                :label="t('common.edit')"
                icon="i-lucide-pencil"
                color="neutral"
                variant="outline"
                :disabled="!account.hasPassword"
                @click="openEmailChange"
              />
            </div>
          </UFormField>
          <UFormField
            :label="t('account.profile.avatar')"
            :description="t('account.profile.avatarDescription')"
          >
            <div class="flex flex-wrap items-center gap-3">
              <UAvatar
                :src="account.avatarUrl ?? undefined"
                :alt="account.name || account.email"
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
                :label="account.avatarUrl ? t('common.replace') : t('common.upload')"
                icon="i-lucide-upload"
                color="neutral"
                variant="outline"
                :loading="avatarBusy === 'upload'"
                :disabled="!!avatarBusy"
                @click="avatarInput?.click()"
              />
              <UButton
                v-if="account.providerAvatar && account.providerAvatar.url !== account.avatarUrl"
                :label="t('account.profile.useProviderPicture', { provider: account.providerAvatar.provider })"
                icon="i-lucide-user-round-check"
                color="neutral"
                variant="ghost"
                :loading="avatarBusy === 'provider'"
                :disabled="!!avatarBusy"
                @click="avatarAction('provider', () => appApi.post('/me/avatar/provider'), t('account.profile.providerPictureError'))"
              />
              <UButton
                v-if="account.avatarUrl"
                :label="t('common.remove')"
                icon="i-lucide-trash-2"
                color="error"
                variant="ghost"
                :loading="avatarBusy === 'remove'"
                :disabled="!!avatarBusy"
                @click="avatarAction('remove', () => appApi.del('/me/avatar'), t('account.profile.avatarRemoveError'))"
              />
            </div>
          </UFormField>
        </section>

        <section class="flex flex-col gap-4">
          <h2 class="border-b border-default pb-2 text-base font-semibold text-highlighted">
            {{ t('account.signIn.title') }}
          </h2>
          <dl class="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-3 text-sm">
            <dt class="text-muted">
              {{ t('account.signIn.password') }}
            </dt>
            <dd class="flex flex-wrap items-center gap-x-3 gap-y-1">
              <template v-if="account.hasPassword">
                <span>{{ t('account.signIn.passwordSet') }}</span>
                <UButton
                  :label="t('account.signIn.changePassword')"
                  icon="i-lucide-key-round"
                  color="neutral"
                  variant="outline"
                  size="xs"
                  @click="passwordOpen = true"
                />
              </template>
              <span
                v-else
                class="text-muted"
              >{{ t('account.signIn.passwordNotSet') }}</span>
            </dd>
            <dt class="text-muted">
              {{ t('account.profile.email') }}
            </dt>
            <dd class="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span :class="account.emailVerifiedAt ? undefined : 'text-warning'">
                {{ account.emailVerifiedAt ? t('account.signIn.verifiedOn', { date: dateTime(account.emailVerifiedAt) }) : t('account.signIn.notVerified') }}
              </span>
              <UButton
                v-if="!account.emailVerifiedAt"
                :label="t('account.signIn.resendVerification')"
                icon="i-lucide-mail"
                color="neutral"
                variant="outline"
                size="xs"
                :loading="resending"
                @click="resendVerification"
              />
            </dd>
            <AccountMfa
              :status="account.mfa"
              :has-password="account.hasPassword"
              @changed="refresh"
            />
            <dt class="text-muted">
              {{ t('account.signIn.lastSignIn') }}
            </dt>
            <dd>{{ account.lastLoginAt ? dateTime(account.lastLoginAt) : t('common.never') }}</dd>
            <dt class="text-muted">
              {{ t('account.signIn.memberSince') }}
            </dt>
            <dd>{{ dateTime(account.createdAt) }}</dd>
          </dl>
        </section>
      </div>
    </PageShell>
    <SessionsTable
      v-else-if="tab === 'sessions'"
      self
    />
    <TokensTable
      v-else-if="tab === 'tokens'"
      self
      :user-id="account.id"
      :planes="tokenPlanes"
    />
    <AccountPreferences v-else-if="tab === 'preferences'" />
    <AuditLogGrid
      v-else
      ref="activity"
      own
      :query="{ principal: account.id }"
      :empty-title="t('account.activity.empty')"
    >
      <template #toolbar>
        <div class="flex items-center gap-3">
          <p class="flex-1 text-sm text-muted">
            {{ t('account.activity.intro') }}
          </p>
          <UTooltip :text="t('common.refresh')">
            <UButton
              :aria-label="t('common.refresh')"
              icon="i-lucide-refresh-cw"
              color="neutral"
              variant="outline"
              square
              :loading="activity?.pending ?? false"
              @click="activity?.refresh()"
            />
          </UTooltip>
        </div>
      </template>
    </AuditLogGrid>

    <UserPasswordModal
      v-model:open="passwordOpen"
      self
      account
      :min-length="account?.passwordMinLength"
      @saved="reload"
    />

    <UModal
      v-model:open="emailOpen"
      :title="t('account.email.changeTitle')"
      :description="t('account.email.changeDescription', { email: account?.email ?? '' })"
    >
      <template #body>
        <form
          id="account-email-form"
          class="flex flex-col gap-5"
          @submit.prevent="changeEmail"
        >
          <UFormField
            :label="t('account.email.newEmail')"
            required
          >
            <UInput
              v-model="newEmail"
              type="email"
              autocomplete="email"
              autofocus
              class="w-full"
            />
          </UFormField>
          <UFormField
            :label="t('account.email.currentPassword')"
            required
            :description="t('account.email.currentPasswordDescription')"
          >
            <UInput
              v-model="emailPassword"
              type="password"
              autocomplete="current-password"
              class="w-full"
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
            form="account-email-form"
            :label="t('common.save')"
            :loading="changingEmail"
            :disabled="!newEmailValid"
          />
        </div>
      </template>
    </UModal>

    <UModal
      v-model:open="leaveOpen"
      :title="t('common.unsavedChanges')"
      :description="t('account.leave.description')"
    >
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            :label="t('common.keepEditing')"
            color="neutral"
            variant="ghost"
            @click="leaveOpen = false"
          />
          <UButton
            :label="t('common.discard')"
            color="error"
            @click="discardAndLeave"
          />
        </div>
      </template>
    </UModal>
  </PageShell>
</template>
