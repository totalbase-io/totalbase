<script setup lang="ts">
/**
 * Set a user's password (PUT /admin/api/users/:id/password) - a step of its
 * own on the user's page, next to "Send password reset" (which OWASP
 * prefers: a password an admin types is known to two people). The server
 * applies a reset's aftermath: lockout ended, pending invitation / reset
 * links retired, the "password changed" notice sent. For the admin's own
 * account it asks for the current password (a stolen session can't change
 * it) and keeps this session when signing out the rest.
 *
 * With `account` (My account, any portal user) it changes the caller's own
 * password through PUT /app/api/me/password instead - always `self`, and
 * the minimum length comes in as `minLength` (an app user can't read
 * /admin/api/settings).
 */
const props = defineProps<{
  userId?: string
  /** The signed-in user's own account. */
  self: boolean
  /** My account: PUT /app/api/me/password. */
  account?: boolean
  /** auth.password_min_length, when the caller already knows it (My account). */
  minLength?: number
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [] }>()

const api = useAdminApi()
const appApi = useAppApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()

// My account takes the minimum as a prop (an app user can't read /admin/api/settings).
const authSettings = props.account ? ref<Record<string, unknown>>({}) : useAuthSettings().data
const minLength = computed(() => {
  if (props.minLength !== undefined) return props.minLength
  const value = authSettings.value?.['auth.password_min_length']
  return typeof value === 'number' ? value : null
})

const currentPassword = ref('')
const password = ref('')
const passwordConfirm = ref('')
const showPassword = ref(false)
const signOut = ref(true)
const saving = ref(false)

watch(open, (isOpen) => {
  if (!isOpen) return
  currentPassword.value = ''
  password.value = ''
  passwordConfirm.value = ''
  showPassword.value = false
  signOut.value = true
})

function generate() {
  const generated = generatePassword(Math.max(16, minLength.value ?? 16))
  password.value = generated
  passwordConfirm.value = generated
  showPassword.value = true
}

const valid = computed(() =>
  (!props.self || currentPassword.value.length > 0)
  && password.value.length >= (minLength.value ?? 1)
  && password.value === passwordConfirm.value
)

async function save() {
  if (!valid.value) return
  saving.value = true
  try {
    if (props.account) {
      await appApi.put('/me/password', { data: { currentPassword: currentPassword.value, password: password.value, signOutOthers: signOut.value } })
    } else {
      await api.put(`/users/${props.userId}/password`, {
        data: {
          password: password.value,
          signOut: signOut.value,
          ...(props.self && { currentPassword: currentPassword.value })
        }
      })
    }
    open.value = false
    toast.add({
      title: t('users.password.saved'),
      description: signOut.value ? (props.self ? t('users.password.othersSignedOut') : t('users.password.userSignedOut')) : undefined,
      color: 'success'
    })
    emit('saved')
  } catch (err) {
    notifyError(err, t('users.password.saveError'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="self ? t('users.password.changeTitle') : t('users.password.setTitle')"
    :description="self ? t('users.password.changeDescription') : t('users.password.setDescription')"
  >
    <template #body>
      <form
        id="user-password-form"
        class="flex flex-col gap-4"
        @submit.prevent="save"
      >
        <UFormField
          v-if="self"
          :label="t('users.password.current')"
          required
        >
          <UInput
            v-model="currentPassword"
            type="password"
            autocomplete="current-password"
            class="w-full"
          />
        </UFormField>
        <UFormField
          :label="t('users.password.new')"
          required
          :description="minLength ? t('users.password.minLength', { n: minLength }) : undefined"
        >
          <UInput
            v-model="password"
            :type="showPassword ? 'text' : 'password'"
            autocomplete="new-password"
            class="w-full"
            :ui="{ base: 'pr-16' }"
          >
            <template #trailing>
              <div class="flex items-center">
                <UTooltip :text="t('users.password.generate')">
                  <UButton
                    icon="i-lucide-wand-sparkles"
                    :aria-label="t('users.password.generate')"
                    color="neutral"
                    variant="link"
                    size="sm"
                    :padded="false"
                    @click="generate"
                  />
                </UTooltip>
                <UTooltip :text="showPassword ? t('users.password.hide') : t('users.password.show')">
                  <UButton
                    :icon="showPassword ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                    :aria-label="showPassword ? t('users.password.hidePassword') : t('users.password.showPassword')"
                    color="neutral"
                    variant="link"
                    size="sm"
                    :padded="false"
                    class="ml-1"
                    @click="showPassword = !showPassword"
                  />
                </UTooltip>
              </div>
            </template>
          </UInput>
        </UFormField>
        <UFormField
          :label="t('users.password.confirm')"
          required
          :error="passwordConfirm && password !== passwordConfirm ? t('users.password.mismatchField') : undefined"
        >
          <UInput
            v-model="passwordConfirm"
            :type="showPassword ? 'text' : 'password'"
            autocomplete="new-password"
            class="w-full"
            :ui="{ base: 'pr-9' }"
          >
            <template #trailing>
              <UTooltip :text="showPassword ? t('users.password.hide') : t('users.password.show')">
                <UButton
                  :icon="showPassword ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                  :aria-label="showPassword ? t('users.password.hidePassword') : t('users.password.showPassword')"
                  color="neutral"
                  variant="link"
                  size="sm"
                  :padded="false"
                  @click="showPassword = !showPassword"
                />
              </UTooltip>
            </template>
          </UInput>
        </UFormField>
        <UCheckbox
          v-model="signOut"
          :label="self ? t('users.password.signOutSelf') : t('users.password.signOutUser')"
          :description="self ? t('users.password.signOutSelfHelp') : t('users.password.signOutUserHelp')"
        />
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          :label="t('common.cancel')"
          color="neutral"
          variant="ghost"
          :disabled="saving"
          @click="open = false"
        />
        <UButton
          type="submit"
          form="user-password-form"
          :label="t('common.save')"
          :loading="saving"
          :disabled="!valid"
        />
      </div>
    </template>
  </UModal>
</template>
