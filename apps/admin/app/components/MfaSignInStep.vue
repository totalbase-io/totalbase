<script setup lang="ts">
/**
 * A portal sign-in's second step (Security.md §2.17), after the password (pages/login.vue) or a provider
 * (pages/auth/oauth.vue) answered with a challenge instead of a session:
 * - VERIFY: the code from the authenticator app, or one of the recovery codes;
 * - ENROLL: the instance requires two-factor authentication and the account has none - set up the app here
 *   (POST /api/auth/mfa/enroll), confirm its first code, then keep the recovery codes before going on.
 * Emits `done` with what the portal's sign-in returns; `cancel` goes back to the start.
 */
import type { AdminAccount } from '~/composables/useSession'
import { useApiErrorMessage } from '~/utils/api-error-message'
import { apiRequest } from '~/utils/api-request'

const props = defineProps<{
  challenge: string
  purpose: 'VERIFY' | 'ENROLL'
}>()
const emit = defineEmits<{
  done: [{ token: string, admin: AdminAccount }]
  cancel: []
}>()

interface VerifyResponse {
  token: string
  admin: AdminAccount
  recoveryCodes: string[] | null
}

const { t } = useI18n()
const api = useAdminApi()
const apiErrorMessage = useApiErrorMessage()

const code = ref('')
const recoveryCode = ref('')
const useRecovery = ref(false)
const loading = ref(false)
const errorMessage = ref<string | null>(null)
/** The challenge can't go on (expired, used, out of attempts): only starting again helps. */
const expired = ref(false)

const enrollment = ref<{ secret: string, otpauthUrl: string } | null>(null)
const enrollError = ref<string | null>(null)
/** An enrollment finished: the codes are shown before the session is used. */
const finished = ref<VerifyResponse | null>(null)

onMounted(async () => {
  if (props.purpose !== 'ENROLL') return
  try {
    const result = await apiRequest<{ secret: string, otpauthUrl: string }>('/api/auth/mfa/enroll', 'POST', { body: { challenge: props.challenge } })
    enrollment.value = result.data
  } catch (error) {
    enrollError.value = apiErrorMessage(error, t('auth.mfa.enrollError'))
  }
})

const canSubmit = computed(() => (useRecovery.value ? recoveryCode.value.trim().length > 0 : /^\d{6}$/.test(code.value.replace(/\s/g, ''))))

async function submit() {
  if (!canSubmit.value) return
  errorMessage.value = null
  loading.value = true
  try {
    const { data } = await api.post<VerifyResponse>('/auth/mfa/verify', {
      challenge: props.challenge,
      ...(useRecovery.value ? { recoveryCode: recoveryCode.value.trim() } : { code: code.value.replace(/\s/g, '') })
    })
    if (data.recoveryCodes) finished.value = data
    else emit('done', { token: data.token, admin: data.admin })
  } catch (error) {
    if (error instanceof AdminApiError && error.code === 'INVALID_MFA_CHALLENGE') expired.value = true
    errorMessage.value = error instanceof AdminApiError && error.code === 'INVALID_MFA_CODE'
      ? t(useRecovery.value ? 'auth.mfa.wrongRecoveryCode' : 'auth.mfa.wrongCode')
      : apiErrorMessage(error, t('auth.login.signInError'))
    code.value = ''
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <template v-if="finished">
      <MfaRecoveryCodes :codes="finished.recoveryCodes!" />
      <UButton
        block
        :label="t('auth.mfa.continue')"
        @click="emit('done', { token: finished.token, admin: finished.admin })"
      />
    </template>

    <template v-else-if="expired">
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
          {{ purpose === 'ENROLL' ? t('auth.mfa.enrollTitle') : t('auth.mfa.title') }}
        </h3>
        <p class="text-sm text-muted">
          {{ purpose === 'ENROLL' ? t('auth.mfa.enrollDescription') : useRecovery ? t('auth.mfa.recoveryDescription') : t('auth.mfa.description') }}
        </p>
      </div>

      <template v-if="purpose === 'ENROLL'">
        <UAlert
          v-if="enrollError"
          color="error"
          variant="subtle"
          :title="enrollError"
        />
        <MfaQrCode
          v-else-if="enrollment"
          :otpauth-url="enrollment.otpauthUrl"
          :secret="enrollment.secret"
        />
      </template>

      <UFormField
        v-if="useRecovery"
        :label="t('auth.mfa.recoveryCode')"
      >
        <UInput
          v-model="recoveryCode"
          autocomplete="off"
          autofocus
          class="w-full font-mono"
        />
      </UFormField>
      <UFormField
        v-else
        :label="t('auth.mfa.code')"
      >
        <UInput
          v-model="code"
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength="7"
          autofocus
          class="w-full font-mono"
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
        :disabled="!canSubmit || (purpose === 'ENROLL' && !enrollment)"
        :label="purpose === 'ENROLL' ? t('auth.mfa.turnOnAndSignIn') : t('auth.mfa.verify')"
      />
      <div class="flex justify-between gap-2">
        <UButton
          :label="t('common.back')"
          color="neutral"
          variant="link"
          size="sm"
          class="px-0"
          @click="emit('cancel')"
        />
        <UButton
          v-if="purpose === 'VERIFY'"
          :label="useRecovery ? t('auth.mfa.useApp') : t('auth.mfa.useRecovery')"
          color="neutral"
          variant="link"
          size="sm"
          class="px-0"
          @click="useRecovery = !useRecovery; errorMessage = null"
        />
      </div>
    </form>
  </div>
</template>
