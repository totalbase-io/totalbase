<script setup lang="ts">
import { rateLimitedUntil } from '~/utils/rate-limit'

// Nuxt UI's own texts (a calendar's months, "Select all", a pagination's labels) in the UI's language.
const ui = useUiLocale()
// On a phone a toast comes from the top: at the bottom it covers a form's Cancel and Save (T57).
const isMobile = useIsMobile()

// Which surface the page belongs to (Admin_UI.md §4.1.1), on
// <html> so the operator's CSS can target one: html[data-surface="app"].
// And the instance's name as the tab's title.
const route = useRoute()
const { instance } = useInstance()
const surface = computed(() => {
  if (route.path === '/login' || route.path.startsWith('/auth/')) return 'auth'
  if (route.path.startsWith('/embed/')) return 'embed'
  if (route.path === '/app' || route.path.startsWith('/app/')) return 'app'
  return 'admin'
})
// The rate limit reached (429): the reads wait its Retry-After and go again
// (utils/rate-limit.ts) - said once per wait, rather than a screen failing.
const { t } = useI18n()
const toast = useToast()
watch(rateLimitedUntil, (until) => {
  const seconds = Math.max(1, Math.ceil((until - Date.now()) / 1000))
  toast.add({ id: 'rate-limited', title: t('common.rateLimited', { seconds }), color: 'warning', icon: 'i-lucide-hourglass', duration: seconds * 1000 })
})
useHead({
  title: computed(() => instance.value.name),
  // The UI language on <html> - what a screen reader pronounces it in (T59).
  htmlAttrs: { 'data-surface': surface, 'lang': ui.languageTag }
})
</script>

<template>
  <UApp
    :locale="ui.nuxtUi.value"
    :toaster="{ position: isMobile ? 'top-center' : 'bottom-right' }"
  >
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
