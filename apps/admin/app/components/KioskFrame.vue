<script setup lang="ts">
/**
 * A kiosk page's frame (`view_config.kiosk`, Specification_DataViews.md
 * §7.3): the page alone, filling the screen - no App menu, no page header.
 *
 * - A discreet "⋮" in a corner: Full screen (the Fullscreen API needs a
 *   person's tap, so it can't start by itself) and, for an administrator,
 *   Exit kiosk view - the same page in the App's frame.
 * - No connection: while the browser is offline, or the server doesn't
 *   answer, a notice covers the page until it is back (utils/connection-
 *   watch.ts). Online only - nothing is queued meanwhile.
 */
import type { DropdownMenuItem } from '@nuxt/ui'
import { createConnectionWatch, type ConnectionProblem } from '~/utils/connection-watch'

const props = defineProps<{
  /** An administrator may leave the kiosk view (Exit kiosk view). */
  canExit: boolean
}>()
const emit = defineEmits<{ exit: [] }>()

const { t } = useI18n()

const problem = ref<ConnectionProblem>(null)
let connection: ReturnType<typeof createConnectionWatch> | null = null

const fullscreenEnabled = ref(false)
const isFullscreen = ref(false)
function syncFullscreen() {
  isFullscreen.value = !!document.fullscreenElement
}
onMounted(() => {
  connection = createConnectionWatch((next) => {
    problem.value = next
  }, { url: '/health/live' })
  fullscreenEnabled.value = document.fullscreenEnabled === true
  syncFullscreen()
  document.addEventListener('fullscreenchange', syncFullscreen)
})
onBeforeUnmount(() => {
  connection?.stop()
  document.removeEventListener('fullscreenchange', syncFullscreen)
})

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await document.documentElement.requestFullscreen()
  } catch {
    // Refused by the browser (no gesture, a frame without allowfullscreen) - the page stays as it is.
  }
}
async function exitKiosk() {
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined)
  emit('exit')
}

const items = computed<DropdownMenuItem[][]>(() => {
  const groups: DropdownMenuItem[][] = []
  if (fullscreenEnabled.value) {
    groups.push([isFullscreen.value
      ? { label: t('dataviews.kiosk.exitFullscreen'), icon: 'i-lucide-minimize', onSelect: toggleFullscreen }
      : { label: t('dataviews.kiosk.fullscreen'), icon: 'i-lucide-maximize', onSelect: toggleFullscreen }])
  }
  if (props.canExit) groups.push([{ label: t('dataviews.kiosk.exitKiosk'), icon: 'i-lucide-log-out', onSelect: exitKiosk }])
  return groups
})
/** The menu closed: the focus leaves it, so a reader's Enter reaches the page (M28). */
function releaseFocus(event: Event) {
  event.preventDefault()
  ;(document.activeElement as HTMLElement | null)?.blur()
}
</script>

<template>
  <div
    data-kiosk
    class="fixed inset-0 flex flex-col bg-default"
  >
    <div class="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
      <slot />
    </div>

    <!-- Discreet until pointed at or focused: a totem shows its page, not the App's controls. -->
    <!-- Closed, the focus leaves it (M28): a reader's Enter must reach the page, not open the menu again. -->
    <UDropdownMenu
      v-if="items.length"
      :items="items"
      :content="{ align: 'end', onCloseAutoFocus: releaseFocus }"
    >
      <UButton
        icon="i-lucide-ellipsis-vertical"
        color="neutral"
        variant="ghost"
        :aria-label="t('dataviews.kiosk.menu')"
        class="absolute top-1 right-1 z-10 opacity-30 hover:opacity-100 focus-visible:opacity-100"
      />
    </UDropdownMenu>

    <div
      v-if="problem"
      role="alert"
      class="absolute inset-0 z-20 flex items-center justify-center bg-default/95 p-6 backdrop-blur-sm"
    >
      <UEmpty
        icon="i-lucide-wifi-off"
        :title="problem === 'offline' ? t('dataviews.kiosk.offlineTitle') : t('dataviews.kiosk.unreachableTitle')"
        :description="t('dataviews.kiosk.offlineDescription')"
        variant="naked"
        size="xl"
      />
    </div>
  </div>
</template>
