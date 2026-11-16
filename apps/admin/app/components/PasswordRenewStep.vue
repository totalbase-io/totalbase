<script setup lang="ts">
/**
 * A portal sign-in's password step (Security.md §2.20): the sign-in was right, but the password is older than
 * auth.password_max_age_days (EXPIRED) or an administrator asked for a new one (REQUESTED) - it is chosen here,
 * before the session. Emits `done` with what the portal's sign-in returns; `mfa` when the instance requires a
 * second factor the account still has to set up (the next step); `cancel` goes back to the start.
 */
import type { AdminAccount } from '~/composables/useSession'
import { useApiErrorMessage } from '~/utils/api-error-message'

const props = defineProps<{
  challenge: string
  reason: 'EXPIRED' | 'REQUESTED'
}>()
const emit = defineEmits<{
  done: [{ admin: AdminAccount }]
  mfa: [{ challenge: string, purpose: 'ENROLL' }]
  cancel: []
}>()

const { t } = useI18n()
const api = useAdminApi()
const apiErrorMessage = useApiErrorMessage()

const password = ref('')
const passwordConfirm = ref('')
const showPassword = ref(false)
const loading = ref(false)
const errorMessage = ref<string | null>(null)
/** The challenge can't go on (expired, used): only starting again helps. */
const expired = ref(false)

const mismatch = computed(() => !!passwordConfirm.value && password.value !== passwordConfirm.value)
const canSubmit = computed(() => !!password.value && password.value === passwordConfirm.value)

async function submit() {
  if (!canSubmit.value) return
  errorMessage.value = null
  loading.value = true
  try {
    // With `mode: 'session'` the session is the cookie: no token in the body (Security.md §2.18).
    const { data } = await api.post<{ admin: AdminAccount }>('/auth/password/renew', {
      challenge: props.challenge,
      newPassword: password.value,
      mode: 'session'
    })
    emit('done', { admin: data.admin })
  } catch (error) {
    if (error instanceof AdminApiError && error.code === 'MFA_ENROLLMENT_REQUIRED') {
      const challenge = error.errors[0]?.meta?.challenge
      if (typeof challenge === 'string') {
        emit('mfa', { challenge, purpose: 'ENROLL' })
        return
      }
    }
    if (error instanceof AdminApiError && error.code === 'INVALID_PASSWORD_CHALLENGE') expired.value = true
    errorMessage.value = expired.value ? t('auth.mfa.expired') : apiErrorMessage(error, t('auth.login.signInError'))
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <template v-if="expired">
      <UAlert
        color="error"
        variant="subtle"
        :title="errorMessage ?? t('auth.mfa.expired')"
      />
      <UButton
        block
        :label="t('auth.mfa.startAgain')"
        @click="emit('cancel')"
      />
    </template>

    <form
      v-else
      class="flex flex-col gap-4"
      @submit.prevent="submit"
    >
      <div class="flex flex-col gap-1">
        <h3 class="font-semibold text-highlighted">
          {{ reason === 'EXPIRED' ? t('auth.passwordRenew.expiredTitle') : t('auth.passwordRenew.requestedTitle') }}
        </h3>
        <p class="text-sm text-muted">
          {{ reason === 'EXPIRED' ? t('auth.passwordRenew.expiredDescription') : t('auth.passwordRenew.requestedDescription') }}
        </p>
      </div>

      <UFormField
        :label="t('auth.tokenPassword.newPassword')"
        required
      >
        <UInput
          v-model="password"
          :type="showPassword ? 'text' : 'password'"
          autocomplete="new-password"
          autofocus
          class="w-full"
        >
          <template #trailing>
            <UButton
              :icon="showPassword ? 'i-lucide-eye-off' : 'i-lucide-eye'"
              :aria-label="showPassword ? t('auth.tokenPassword.hidePassword') : t('auth.tokenPassword.showPassword')"
              color="neutral"
              variant="link"
              size="sm"
              :padded="false"
              @click="showPassword = !showPassword"
            />
          </template>
        </UInput>
      </UFormField>
      <UFormField
        :label="t('auth.tokenPassword.confirmPassword')"
        required
        :error="mismatch ? t('auth.tokenPassword.mismatch') : undefined"
      >
        <UInput
          v-model="passwordConfirm"
          :type="showPassword ? 'text' : 'password'"
          autocomplete="new-password"
          class="w-full"
        />
      </UFormField>

      <UAlert
        v-if="errorMessage"
        color="error"
        variant="subtle"
        :title="errorMessage"
      />

      <UButton
        type="submit"
        block
        :loading="loading"
        :disabled="!canSubmit"
        :label="t('auth.passwordRenew.submit')"
      />
      <div>
        <UButton
          :label="t('common.back')"
          color="neutral"
          variant="link"
          size="sm"
          class="px-0"
          @click="emit('cancel')"
        />
      </div>
    </form>
  </div>
</template>
