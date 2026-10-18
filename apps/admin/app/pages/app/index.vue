<script setup lang="ts">
// The App's landing page (Specification_Security.md §8): the menu
// lives in the panel beside it (AppMenuPanel.vue); an administrator
// arranges it here, in edit mode (`?edit`).
import { menuObjectPath } from '~/types/app-menu'
import { appOpeningLocation, storedAppLocation } from '~/utils/app-last-visited'

const route = useRoute()
const session = useSession()
const { t } = useI18n()
const editing = computed(() => session.access.value === 'ADMIN' && route.query.edit !== undefined)
// Where the App opens (Specification_Security.md §8.1), in place of this page: the object last visited in this
// browser, else the role's home, else the first of the menu - this page only stays when the menu is empty.
const { menu, loading } = useAppMenu()
const opening = computed(() => {
  if (!menu.value || editing.value) return undefined
  const userId = session.admin.value?.id
  return appOpeningLocation(menu.value.nodes, menu.value.home, userId ? storedAppLocation(userId) : undefined)
})
watch(opening, (target) => {
  if (target) void navigateTo(menuObjectPath(target), { replace: true })
}, { immediate: true })
</script>

<template>
  <LazyAppMenuEditor v-if="editing" />
  <div
    v-else-if="!loading && !opening"
    class="flex h-full flex-col items-center justify-center gap-2 p-8 text-center"
  >
    <UIcon
      name="i-lucide-app-window"
      class="size-10 text-muted"
    />
    <p class="font-medium text-highlighted">
      {{ t('dataviews.appHome.title') }}
    </p>
    <p class="max-w-sm text-sm text-muted">
      {{ t('dataviews.appHome.description') }}
    </p>
  </div>
</template>
