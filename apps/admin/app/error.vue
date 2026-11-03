<script setup lang="ts">
import type { NuxtError } from '#app'

// The SPA's not-found page (Foundations.md §4.1, Admin_UI.md §3.6): a path
// no page answers - a mistyped address, a bookmark from before the admin
// moved to the root - and any other error Nuxt raises while rendering.
// Nuxt UI's own page, its texts from the shell locale area (loaded with
// the app); the button clears the error and goes to `/`, which the auth
// middleware turns into the user's home, or the sign-in.
const props = defineProps<{ error: NuxtError }>()
const { t } = useI18n()
const notFound = computed(() => props.error.statusCode === 404)
const error = computed(() => ({
  statusCode: props.error.statusCode,
  statusMessage: notFound.value ? t('errors.pageNotFound') : t('errors.pageFailed'),
  message: notFound.value ? t('errors.pageNotFoundHint') : props.error.message
}))
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-default p-4">
    <UError
      :error="error"
      :clear="{ label: t('errors.backHome') }"
      redirect="/"
    />
  </div>
</template>
