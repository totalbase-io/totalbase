<script setup lang="ts">
/**
 * "Confirm it's you" - asked when a sensitive action answers REAUTHENTICATION_REQUIRED (Security.md §2.19):
 * the password, or a code from the authenticator app. Opened through Nuxt UI's useOverlay by
 * useReauthentication; closes with whether the identity was confirmed, and the action is then retried.
 */
const emit = defineEmits<{ close: [confirmed: boolean] }>()
const { t } = useI18n()
const api = useAdminApi()
const apiErrorMessage = useApiErrorMessage()

const withCode = ref(false)
const password = ref('')
const code = ref('')
const loading = ref(false)
const errorMessage = ref<string | null>(null)

const canSubmit = computed(() => (withCode.value ? code.value.trim().length > 0 : password.value.length > 0))

async function submit() {
  if (!canSubmit.value) return
  errorMessage.value = null
  loading.value = true
  try {
    await api.post('/auth/reauthenticate', withCode.value ? { code: code.value.replace(/\s/g, '') } : { password: password.value })
    emit('close', true)
  } catch (error) {
    errorMessage.value = apiErrorMessage(error, t('auth.reauthenticate.error'))
    password.value = ''
    code.value = ''
  } finally {
    loading.value = false
  }
}

function switchMethod() {
  withCode.value = !withCode.value
  errorMessage.value = null
}
</script>

<template>
  <UModal
    :title="t('auth.reauthenticate.title')"
    :description="t('auth.reauthenticate.description')"
    @update:open="(open: boolean) => { if (!open) emit('close', false) }"
  >
    <template #body>
      <form
        id="reauthenticate-form"
        class="space-y-4"
        @submit.prevent="submit"
      >
        <UFormField
          v-if="withCode"
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
        <UFormField
          v-else
          :label="t('auth.reauthenticate.password')"
        >
          <UInput
            v-model="password"
            type="password"
            autocomplete="current-password"
            autofocus
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
          :label="withCode ? t('auth.reauthenticate.usePassword') : t('auth.reauthenticate.useCode')"
          color="neutral"
          variant="link"
          size="sm"
          class="px-0"
          @click="switchMethod"
        />
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          :label="t('common.cancel')"
          color="neutral"
          variant="outline"
          @click="emit('close', false)"
        />
        <UButton
          type="submit"
          form="reauthenticate-form"
          :label="t('auth.reauthenticate.confirm')"
          :loading="loading"
          :disabled="!canSubmit"
        />
      </div>
    </template>
  </UModal>
</template>
