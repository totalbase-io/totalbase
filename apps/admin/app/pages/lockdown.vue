<script setup lang="ts">
// Where a signed-in user who isn't an administrator waits out a lockdown (Security.md §2.21): sent here by the
// first request answered 503 LOCKDOWN (useAdminApi), or at boot (auth.global.ts). Their session stays - "Try again"
// loads the portal anew; an administrator on the same browser signs in from here.
definePageMeta({ layout: false })

const { t } = useI18n()
const lockdown = useLockdown()

function retry() {
  window.location.assign(`${useRuntimeConfig().app.baseURL.replace(/\/$/, '')}/`)
}
</script>

<template>
  <AuthPublicCard>
    <div class="flex size-10 items-center justify-center rounded-full bg-warning/10">
      <UIcon
        name="i-lucide-lock"
        class="size-5 text-warning"
      />
    </div>
    <h1 class="text-lg font-semibold text-highlighted">
      {{ t('auth.lockdown.title') }}
    </h1>
    <p class="text-sm text-muted">
      {{ lockdown.text(t('auth.lockdown.description')) }}
    </p>
    <UButton
      :label="t('auth.lockdown.tryAgain')"
      block
      @click="retry"
    />
    <UButton
      :label="t('auth.lockdown.signInOther')"
      to="/login"
      color="neutral"
      variant="link"
      block
    />
  </AuthPublicCard>
</template>
