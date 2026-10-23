<script setup lang="ts">
/**
 * The page a system email's link opens when it asks for a new password -
 * accepting an invitation, or resetting a forgotten password. Reads the
 * single-use `?token=` from the URL and posts it with the new password to
 * the public auth route (`endpoint`). Public: reached signed-out, from an
 * email (see middleware/auth.global.ts's PUBLIC_PREFIXES).
 */
const props = defineProps<{
  endpoint: string
  title: string
  description: string
  submitLabel: string
  successTitle: string
  successDescription: string
}>()

const route = useRoute()
const { t, te, locale } = useI18n()
const token = computed(() => typeof route.query.token === 'string' ? route.query.token : '')

const password = ref('')
const passwordConfirm = ref('')
const showPassword = ref(false)
const submitting = ref(false)
const errorMessage = ref<string | null>(null)
const done = ref(false)

const mismatch = computed(() => !!passwordConfirm.value && password.value !== passwordConfirm.value)

async function submit() {
  errorMessage.value = null
  if (!password.value || password.value !== passwordConfirm.value) {
    errorMessage.value = t('auth.tokenPassword.mustMatch')
    return
  }
  submitting.value = true
  try {
    await $fetch(props.endpoint, { method: 'POST', body: { token: token.value, password: password.value } })
    done.value = true
  } catch (err) {
    const data = (err as { data?: { errors?: Array<{ code?: string, message?: string }> } }).data
    const first = data?.errors?.[0]
    errorMessage.value = first?.code === 'INVALID_TOKEN'
      ? t('auth.tokenPassword.invalidToken')
      : locale.value !== 'en' && first?.code && te(`errors.${first.code}`) ? t(`errors.${first.code}`) : first?.message ?? t('auth.genericError')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <AuthPublicCard>
    <template v-if="!token">
      <h1 class="text-lg font-semibold text-highlighted">
        {{ t('auth.linkIncomplete.title') }}
      </h1>
      <p class="text-sm text-muted">
        {{ t('auth.linkIncomplete.description') }}
      </p>
    </template>

    <template v-else-if="done">
      <div class="flex size-10 items-center justify-center rounded-full bg-success/10">
        <UIcon
          name="i-lucide-check"
          class="size-5 text-success"
        />
      </div>
      <h1 class="text-lg font-semibold text-highlighted">
        {{ successTitle }}
      </h1>
      <p class="text-sm text-muted">
        {{ successDescription }}
      </p>
      <UButton
        :label="t('auth.goToSignIn')"
        to="/login"
        block
      />
    </template>

    <form
      v-else
      class="flex flex-col gap-4"
      @submit.prevent="submit"
    >
      <div class="flex flex-col gap-1">
        <h1 class="text-lg font-semibold text-highlighted">
          {{ title }}
        </h1>
        <p class="text-sm text-muted">
          {{ description }}
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
          class="w-full"
          :ui="{ base: 'pr-9' }"
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
          :ui="{ base: 'pr-9' }"
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
      <UAlert
        v-if="errorMessage"
        color="error"
        variant="subtle"
        :title="errorMessage"
      />
      <UButton
        type="submit"
        :label="submitLabel"
        :loading="submitting"
        block
      />
    </form>
  </AuthPublicCard>
</template>
