<script setup lang="ts">
import { PAGE_FRAME_KEY, PAGE_NAVBARS_KEY } from '~/utils/page-navbar'

/**
 * The frame every admin data/content page renders in (AGENTS.md section
 * 25, "Page structure"):
 *
 *   #header   PageHeader - the panel's navbar, fixed, rule below
 *   #toolbar  optional filters/search row - fixed, under the header
 *   default   the page's content - the ONLY region that scrolls
 *   #footer   optional - pagination (TablePager) and a result summary
 *             only, never actions (Save etc. belong in the header)
 *
 * A UDashboardPanel (Nuxt UI's dashboard template) - its PageHeader the
 * panel's UDashboardNavbar -, filling the layout's <main> (which has no
 * padding of its own), so header and footer stay put while the body
 * scrolls. Props:
 * - `flush`: no padding around the body - grids, editors and designers
 *   that manage their own edges.
 * - `scroll=false`: the body doesn't scroll itself - for content that
 *   manages its own scrolling (a full-height editor, a split pane).
 * - `embedded`: the same slots laid out inline instead of as a full-page
 *   frame (no fixed height, rules or outer padding) - for a page's table
 *   reused inside another page, e.g. a user's Tokens tab.
 */
const props = withDefaults(defineProps<{
  flush?: boolean
  scroll?: boolean
  embedded?: boolean
}>(), {
  flush: false,
  scroll: true,
  embedded: false
})
const slots = useSlots()

// Its PageHeader is the panel's UDashboardNavbar - or, embedded, a header without the page's chrome.
provide(PAGE_FRAME_KEY, props.embedded ? 'embedded' : 'page')
// The layout shows its own header only on a page without one of these.
const navbars = inject(PAGE_NAVBARS_KEY, null)
const counts = computed(() => !props.embedded && !!slots.header)
onMounted(() => {
  if (counts.value && navbars) navbars.value++
})
onBeforeUnmount(() => {
  if (counts.value && navbars) navbars.value--
})
</script>

<template>
  <div
    v-if="embedded"
    class="flex flex-col gap-4"
  >
    <slot name="header" />
    <slot name="toolbar" />
    <slot />
    <slot name="footer" />
  </div>
  <UDashboardPanel v-else>
    <!-- The PageHeader: the panel's UDashboardNavbar. -->
    <slot name="header" />
    <div
      v-if="$slots.toolbar"
      class="shrink-0 px-4 pt-4 sm:px-6"
    >
      <slot name="toolbar" />
    </div>
    <div
      class="min-h-0 flex-1"
      data-fill-height-frame
      :class="[
        scroll ? 'overflow-auto' : 'flex flex-col overflow-hidden',
        flush ? undefined : ($slots.toolbar ? 'px-4 pb-4 pt-3 sm:px-6 sm:pb-6' : 'p-4 sm:p-6')
      ]"
    >
      <slot />
    </div>
    <div
      v-if="$slots.footer"
      class="shrink-0 border-t border-default px-4 py-3 sm:px-6"
    >
      <slot name="footer" />
    </div>
  </UDashboardPanel>
</template>
