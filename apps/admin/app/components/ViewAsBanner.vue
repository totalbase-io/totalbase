<script setup lang="ts">
/**
 * While previewing the App as someone (view-as.ts): who, that nothing is saved, and the way back - above every App
 * page, never on an admin screen.
 */
import { isAppPath, setViewAs, viewAsState } from '~/utils/view-as'

const { t } = useI18n()
const route = useRoute()
const shown = computed(() => viewAsState.value && isAppPath(route.path))

function exit() {
  setViewAs(null)
  window.location.assign(`${useRuntimeConfig().app.baseURL.replace(/\/$/, '')}/app`)
}
</script>

<template>
  <div
    v-if="shown"
    role="status"
    class="flex items-center gap-2 border-b border-default bg-warning/10 px-4 py-1.5 text-sm"
  >
    <UIcon
      name="i-lucide-eye"
      class="size-4 shrink-0 text-warning"
    />
    <span class="min-w-0 flex-1 truncate">{{ t('shell.viewAs.banner', { name: viewAsState!.name }) }}</span>
    <UButton
      :label="t('shell.viewAs.exit')"
      size="xs"
      color="neutral"
      variant="outline"
      @click="exit"
    />
  </div>
</template>
