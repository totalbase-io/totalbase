<script setup lang="ts">
// Opened from an email verification email (auth.links.email_verification's
// default). Verifies as soon as it loads - there's nothing to fill in.
definePageMeta({ layout: false })

const route = useRoute()
const { t, te, locale } = useI18n()
const token = typeof route.query.token === 'string' ? route.query.token : ''
const state = ref<'verifying' | 'done' | 'failed'>(token ? 'verifying' : 'failed')
// Empty without a token: the template then reads the incomplete-link text in the current language.
const message = ref('')

onMounted(async () => {
  if (!token) return
  try {
    await $fetch('/api/auth/email/verify', { baseURL: '/', method: 'POST', body: { token } })
    state.value = 'done'
  } catch (err) {
    const first = (err as { data?: { errors?: Array<{ code?: string, message?: string }> } }).data?.errors?.[0]
    message.value = first?.code === 'INVALID_TOKEN'
      ? t('auth.verifyEmail.invalidToken')
      : locale.value !== 'en' && first?.code && te(`errors.${first.code}`) ? t(`errors.${first.code}`) : first?.message ?? t('auth.genericError')
    state.value = 'failed'
  }
})
</script>

<template>
  <AuthPublicCard>
    <div
      v-if="state === 'verifying'"
      class="flex items-center gap-2 text-sm text-muted"
    >
      <UIcon
        name="i-lucide-loader-circle"
        class="size-4 animate-spin"
      />
      {{ t('auth.verifyEmail.confirming') }}
    </div>
    <template v-else-if="state === 'done'">
      <div class="flex size-10 items-center justify-center rounded-full bg-success/10">
        <UIcon
          name="i-lucide-check"
          class="size-5 text-success"
        />
      </div>
      <h1 class="text-lg font-semibold text-highlighted">
        {{ t('auth.verifyEmail.confirmed') }}
      </h1>
      <p class="text-sm text-muted">
        {{ t('auth.verifyEmail.confirmedDescription') }}
      </p>
      <UButton
        :label="t('auth.goToSignIn')"
        to="/login"
        block
      />
    </template>
    <template v-else>
      <h1 class="text-lg font-semibold text-highlighted">
        {{ t('auth.verifyEmail.failed') }}
      </h1>
      <p class="text-sm text-muted">
        {{ message || t('auth.verifyEmail.linkIncomplete') }}
      </p>
    </template>
  </AuthPublicCard>
</template>
