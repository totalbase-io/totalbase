<script setup lang="ts">
// Nuxt UI's own texts (a calendar's months, "Select all", a pagination's labels) in the UI's language.
const ui = useUiLocale()
// On a phone a toast comes from the top: at the bottom it covers a form's Cancel and Save (T57).
const isMobile = useIsMobile()

// Which surface the page belongs to (Specification_Admin_UI.md §4.1.1), on
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
