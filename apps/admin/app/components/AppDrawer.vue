<script setup lang="ts">
/**
 * Shared chrome for every bottom UDrawer in the admin - title + a
 * one-line description stacked below it (same layout as PageHeader, so
 * a drawer's header reads the same way a page's does), an
 * expand/collapse toggle, and Close. Extracted so TableDrawer.vue,
 * SqlConsoleDrawer.vue, and templates.vue/mailings.vue's inline drawers
 * stop each reimplementing the same header row and sizing classes
 * (AGENTS.md §25 "UDrawer vs USlideover").
 *
 * Deliberately bottom-only, no direction prop - see that same AGENTS.md
 * section: which container to use (drawer vs sidebar) is a decision the
 * screen's author makes based on the content's weight, not something
 * exposed as a user preference per instance.
 *
 * `size` only affects the *collapsed* width - expanded always goes to
 * the same near-fullscreen size regardless, since "I need more room
 * right now" means the same thing everywhere. A phone always gets the
 * full width and most of the height - there's no room to collapse to,
 * so no expand toggle either.
 */
type DrawerSize = 'default' | 'sm' | 'md' | 'lg' | 'xl'
const props = withDefaults(defineProps<{
  title: string
  /** A short one-line caption below the title, e.g. what this drawer does or what mode it's in - not a paragraph (that belongs in the body). */
  description?: string
  /** Shows the expand/collapse toggle. Turn off for a drawer whose content doesn't benefit from more room (e.g. a short compose form) - see mailings.vue's compose drawer. */
  expandable?: boolean
  /** Collapsed width: default - UDrawer's own width and height, none of ours (a record form with no size chosen), its body scrolling past Nuxt UI's max height; sm ~60% (a single-column form), md ~80% (two-pane forms), lg ~88% (the default - every drawer in the app uses this width, per admin preference), xl ~94% (barely short of the expanded near-fullscreen size - for a DataView's Edit form when the user wants maximum room without giving up the collapse toggle; see the Design form's own Mode/Size settings). */
  size?: DrawerSize
  /** Passed through to UDrawer. Default false, matching every drawer so far (AGENTS.md's vaul-vue will-change note applies only to non-dismissible drawers - see that section before turning this on). */
  dismissible?: boolean
  /** Esc closes it (through `open`, so a caller's own guard - a record's unsaved edits - still runs first) while it stays non-dismissible to a click outside or a drag. A select or a popover open inside takes the Esc first. Default off: a working drawer (SQL Console, a table's editor) is left alone. */
  closeOnEscape?: boolean
  /** Opens already expanded instead of at the collapsed `size` - for content that only really works with near-fullscreen room (e.g. the PDF template designer), so the user isn't stuck collapsing-then-expanding every time. Still collapsible via the same toggle. */
  startExpanded?: boolean
}>(), {
  description: undefined,
  expandable: true,
  size: 'lg',
  dismissible: false,
  closeOnEscape: false,
  startExpanded: false
})

const open = defineModel<boolean>('open', { required: true })
const expanded = ref(props.startExpanded)

const COLLAPSED_WIDTH: Record<DrawerSize, string> = {
  default: '',
  sm: 'inset-x-[20%] w-[60%]',
  md: 'inset-x-[10%] w-[80%]',
  lg: 'inset-x-[6%] w-[88%]',
  xl: 'inset-x-[3%] w-[94%]'
}
const EXPANDED_CLASS = 'inset-x-4 w-[calc(100%-2rem)] h-[92vh] max-h-[92vh] rounded-lg'
const MOBILE_CLASS = 'inset-x-0 w-full h-[92vh] max-h-[92vh] rounded-t-lg'
const isMobile = useIsMobile()
const { t } = useI18n()
/** Default, collapsed: Nuxt UI's own size - full width, as tall as its content up to its max-h-[96%]. */
const nuxtSize = computed(() => props.size === 'default' && !expanded.value)
const drawerClass = computed(() => {
  if (nuxtSize.value) return ''
  if (isMobile.value) return MOBILE_CLASS
  return expanded.value ? EXPANDED_CLASS : `${COLLAPSED_WIDTH[props.size]} h-[85vh] max-h-[85vh] rounded-lg`
})

function close() {
  open.value = false
}
/** The drawer's own Escape (vaul's, only when it's the topmost layer) - UDrawer prevents the close when not dismissible; this closes it anyway when asked. */
const contentProps = computed(() => (props.closeOnEscape && !props.dismissible ? { onEscapeKeyDown: close } : {}))

// Reset to startExpanded each time the drawer opens, rather than
// remembering whatever "expanded" was left at from a previous open -
// same behavior every drawer listed in the doc comment already had
// before this component existed.
watch(open, (isOpen) => {
  if (isOpen) expanded.value = props.startExpanded
})
</script>

<template>
  <!-- title/description name the dialog for assistive tech (rendered
  visually hidden, since #content draws its own header). -->
  <UDrawer
    :open="open"
    :title="title"
    :description="description"
    direction="bottom"
    :handle="false"
    :dismissible="dismissible"
    :content="contentProps"
    inset
    :ui="{ content: 'transition-[inset,width,height] duration-200' }"
    :class="drawerClass"
    @update:open="(v: boolean) => (open = v)"
  >
    <template #content>
      <div :class="['flex w-full flex-col gap-3 p-4', nuxtSize ? 'min-h-0' : 'h-full']">
        <div class="flex items-start justify-between gap-2 border-b border-default pb-3 shrink-0">
          <div class="min-w-0">
            <h2 class="text-base font-bold text-highlighted truncate">
              {{ title }}
            </h2>
            <p
              v-if="description"
              class="text-xs text-muted mt-0.5 truncate"
            >
              {{ description }}
            </p>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <!-- Optional, e.g. a record's other actions (RecordHeaderActions.vue) - right next to Expand/Close. -->
            <slot name="header-actions" />
            <UTooltip
              v-if="expandable && !isMobile"
              :text="expanded ? t('shell.drawer.collapse') : t('shell.drawer.expand')"
            >
              <UButton
                :icon="expanded ? 'i-lucide-minimize-2' : 'i-lucide-maximize-2'"
                :aria-label="expanded ? t('shell.drawer.collapse') : t('shell.drawer.expand')"
                color="neutral"
                variant="outline"
                size="sm"
                square
                @click="expanded = !expanded"
              />
            </UTooltip>
            <UTooltip :text="t('common.close')">
              <UButton
                icon="i-lucide-x"
                :aria-label="t('common.close')"
                color="neutral"
                variant="outline"
                size="sm"
                square
                @click="close"
              />
            </UTooltip>
          </div>
        </div>

        <!-- Optional: a row of controls right under the header. -->
        <div
          v-if="$slots.toolbar"
          class="border-b border-default pb-3 shrink-0"
        >
          <slot name="toolbar" />
        </div>

        <div :class="['flex-1 min-h-0 flex flex-col', nuxtSize && 'overflow-y-auto']">
          <slot />
        </div>

        <div
          v-if="$slots.footer"
          class="border-t border-default pt-3 shrink-0"
        >
          <slot name="footer" />
        </div>
      </div>
    </template>
  </UDrawer>
</template>

<!-- The [data-vaul-drawer] will-change/blur fix lives globally in
app/assets/css/main.css (every UDrawer needs it) - see AGENTS.md §25
"UDrawer text blur (vaul-vue)". -->
