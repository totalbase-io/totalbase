<script setup lang="ts">
/**
 * A dashboard embed (Specification_Dashboards.md §9.5), framed by another
 * site. Its address says which:
 * - `/admin/embed/tbe_…` - a public link: the path is its credential;
 * - `/admin/embed/<embed id>#<token>` - a signed embed: a portal's backend
 *   signs the token per visit;
 * - `/admin/embed/preview#<token>` - the drawer's preview, signed by
 *   TotalBase for an administrator.
 * A token sits in the URL's fragment - never sent to a server, so never in
 * a log or a Referer. The credential goes to /embed/api in a header. No app
 * shell, no session: the visitor has no TotalBase account. Who may frame
 * the page is the server's frame-ancestors, per embed. The dashboard's id
 * is never in the address.
 *
 * How it looks is the embed's own (the drawer); the query string may
 * override presentation and starting values (utils/embed-params.ts) -
 * never what the embed locks. The page tells its parent its height
 * (`totalbase:embed:resize`) to size the frame.
 */
import { isUiLanguage } from '@totalbase/shared'
import { parseEmbedParams } from '~/utils/embed-params'

definePageMeta({ layout: false })

const route = useRoute()
const key = String(route.params.key ?? '')
const isLink = key.startsWith('tbe_')
const params = parseEmbedParams(route.query)
const colorMode = useColorMode()

const credential = ref<string | null>(null)
/** A public link opened on its own, outside any frame - a deterrent, not security: the link is public. */
const notFramed = ref(false)
const variableValues = ref<Record<string, unknown>>({})
const root = ref<HTMLElement | null>(null)
const view = ref<{ dashboard: { language?: string, display?: { theme?: 'light' | 'dark' | 'auto', transparent?: boolean } } | null } | null>(null)
// No user: the URL's `locale`, else the instance's language (Specification_Admin_UI.md §14).
const { setLocale, locale, t } = useI18n()
watch(() => params.locale ?? view.value?.dashboard?.language, (language) => {
  if (isUiLanguage(language) && language !== locale.value) void setLocale(language)
}, { immediate: true })

// Its notices before the dashboard answers (DB30): the instance's language, unless the URL names one.
const instanceLanguage = ref<string | null>(null)
onMounted(async () => {
  if (params.locale) return
  try {
    const instance = await $fetch<{ data: { language?: string } }>('/api/instance')
    instanceLanguage.value = instance.data.language ?? null
  } catch {
    // Unknown: English until the dashboard says.
  }
})
watch(instanceLanguage, (language) => {
  if (!view.value?.dashboard?.language && isUiLanguage(language) && language !== locale.value) void setLocale(language)
})

const display = computed(() => view.value?.dashboard?.display)
const transparent = computed(() => params.transparent ?? display.value?.transparent ?? false)
watch([display, () => params.theme], () => {
  const theme = params.theme ?? (display.value?.theme === 'auto' ? 'system' : display.value?.theme)
  if (theme) colorMode.preference = theme
}, { immediate: true })
watch(transparent, (clear) => {
  if (!import.meta.client) return
  document.documentElement.style.background = clear ? 'transparent' : ''
  document.body.style.background = clear ? 'transparent' : ''
})

/**
 * The embedding page, the only one a resize message goes to: framing is
 * already limited to the embed's sites by the browser, so the parent is one
 * of them. Unknown (an old browser hiding both), no message - never `*`.
 */
function parentOrigin(): string | null {
  const ancestors = (window.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins
  if (ancestors && ancestors.length > 0) return ancestors[0] ?? null
  try {
    return document.referrer ? new URL(document.referrer).origin : null
  } catch {
    return null
  }
}

let observer: ResizeObserver | null = null
onMounted(() => {
  notFramed.value = isLink && window.top === window
  credential.value = isLink ? key : decodeURIComponent(window.location.hash.replace(/^#/, ''))
  const target = parentOrigin()
  if (window.parent !== window && target && root.value) {
    let last = 0
    observer = new ResizeObserver(() => {
      const height = Math.ceil(root.value?.scrollHeight ?? 0)
      if (height === last) return
      last = height
      window.parent.postMessage({ type: 'totalbase:embed:resize', height }, target)
    })
    observer.observe(root.value)
  }
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div
    ref="root"
    class="p-3"
    :class="transparent ? 'bg-transparent' : 'min-h-dvh bg-default'"
  >
    <UEmpty
      v-if="notFramed"
      icon="i-lucide-app-window"
      :title="t('shell.embed.onlyEmbedded')"
      :description="t('shell.embed.onlyEmbeddedDescription')"
      variant="naked"
    />
    <UEmpty
      v-else-if="credential === ''"
      icon="i-lucide-lock"
      :title="t('shell.embed.notAvailable')"
      :description="t('shell.embed.noToken')"
      variant="naked"
    />
    <DashboardView
      v-else-if="credential"
      ref="view"
      v-model:variable-values="variableValues"
      :embed-token="credential"
      :titled="params.titled"
      :hide-bar="params.hideBar"
      :hidden-variables="params.hiddenVariables"
      :initial-query="params.variables"
      :refresh-override="params.refreshSeconds"
    />
  </div>
</template>
