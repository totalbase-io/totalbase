<script setup lang="ts">
/**
 * An EXTERNALFRAME DataView's layout: one sandboxed iframe over an
 * external https page (Specification_DataViews.md,
 * "EXTERNALFRAME security"). Props in, no route reading (AGENTS.md §21A) -
 * the App page, the version preview, the wizard and the settings preview
 * all mount it the same way. `enterFullscreen()` is exposed for the host's
 * header action.
 *
 * The sandbox is fixed: scripts + same-origin are both allowed because the
 * URL can never be TotalBase's own origin (checked on save server-side and
 * again here by `embeddableFrameUrl`), and a cross-origin document can't
 * reach this page either way.
 */
import { embeddableFrameUrl } from '~/utils/frame-url'

const props = defineProps<{ url: string, title: string }>()
const { t } = useI18n()

const FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox'

const src = computed(() => embeddableFrameUrl(props.url))
const frameRef = ref<HTMLIFrameElement | null>(null)

function enterFullscreen() {
  frameRef.value?.requestFullscreen?.().catch(() => {})
}

defineExpose({ enterFullscreen })
</script>

<template>
  <iframe
    v-if="src"
    ref="frameRef"
    :key="src"
    :src="src"
    :title="title"
    :sandbox="FRAME_SANDBOX"
    allow="fullscreen"
    referrerpolicy="no-referrer"
    loading="lazy"
    class="block size-full min-h-0 flex-1 border-0 bg-default"
  />
  <UEmpty
    v-else
    icon="i-lucide-app-window"
    :title="t('dataviews.frame.emptyTitle')"
    :description="t('dataviews.frame.emptyDescription')"
    variant="naked"
    class="flex-1"
  />
</template>
