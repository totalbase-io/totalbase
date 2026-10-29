<script setup lang="ts">
/**
 * The one page header (AGENTS.md section 25). Actions come in three kinds,
 * so a phone can fold what doesn't fit into one "⋮" menu while a desktop
 * keeps every button in sight:
 *
 * - default slot: the primary action (New, Save, Publish) and its state
 *   (an "Unsaved" badge) - visible at every width;
 * - `#status`: an editor's SaveStatus, beside the title - where the eye
 *   already is, and away from the actions;
 * - `actions`: secondary actions (Refresh, Logs, Variables) - buttons on
 *   desktop, items of the "⋮" menu on a phone;
 * - `menu`: actions on the object itself (Settings…, Delete…) - a "⋮" at
 *   the right end on desktop, the last groups of the "⋮" on a phone.
 *
 * `#search` holds a HeaderSearch, first among the actions. `mobileMenu`
 * adds groups that exist only in the phone menu, for a control the page
 * hides on a phone (the versions chip). `selection` puts a list's bulk
 * actions in the header while rows are selected (HeaderSelection).
 */
import type { DropdownMenuItem } from '@nuxt/ui'
import { PAGE_FRAME_KEY, PANEL_FOLDED_KEY } from '~/utils/page-navbar'
import { docsLinkFor } from '~/utils/docs-links'
import { isAppPath } from '~/utils/view-as'

const props = defineProps<{
  title: string
  description?: string
  /** Optional icon shown before the title - e.g. a DataView's own icon on its grid page (database/dataviews.vue's list already shows it per row; this is the same icon on the page you land on). Rendered inside a rounded "halo" tile rather than bare, matching the reference screenshot. Replaced by a Back arrow when `iconBack`/`iconTo` makes the tile a Back button. */
  icon?: string
  /** An image (e.g. a user's avatar) shown in the icon tile instead of `icon` - unless the tile is a Back button. Falls back to `icon` if it fails to load. */
  avatar?: string | null
  /**
   * Turns the icon halo into a link to one FIXED route - a route
   * string, same as NuxtLink's own `to`. Prefer `iconBack` (below)
   * instead for a "Back" affordance in almost every case: this project
   * keeps finding pages that get reached from more than one place, or
   * will later (prompted by a real bug -
   * settings.vue's own Back arrow always jumping to the DataView's grid
   * even when arrived from the DataViews list; also flagged for
   * [pk]/edit.vue, whose edit form may itself become embeddable/
   * callable from more than its own grid down the line). A real link
   * DOES still beat `iconBack` when a page's parent is genuinely fixed
   * forever by construction (not just "happens to be one place today")
   * and right-click/open-in-new-tab/middle-click on the icon itself
   * matters - narrow enough that `iconTo` should be the exception, not
   * the default, going forward. Together with `iconBack` it's only the
   * FALLBACK: where Back goes when there's no in-app page to go back to
   * (the page was opened from a direct link or in a new tab).
   */
  iconTo?: string
  /**
   * Turns the icon halo into a real browser-history "Back" button
   * (`router.back()`) instead of a link to one fixed route - the
   * DEFAULT choice for a "Back" affordance on this project's pages (see
   * `iconTo`'s own doc comment for why). Always returns wherever the
   * visitor actually came from, so it stays correct even as a page
   * gains more entry points later, at the one real cost: no right-
   * click/open-in-new-tab/middle-click, since there's no href to open.
   */
  iconBack?: boolean
  /** An editor's header (a designer, a canvas): its secondary actions set apart from status and publishing. */
  height?: 'default' | 'editor'
  /** Secondary actions - see the component's doc comment. */
  actions?: HeaderAction[]
  /** Actions on the object itself - see the component's doc comment. */
  menu?: DropdownMenuItem[][]
  /** An action from `menu` is running - a spinner on its "⋮". */
  menuLoading?: boolean
  /** Extra groups for the phone's "⋮" menu only. */
  mobileMenu?: DropdownMenuItem[][]
  /** A list's row selection - see HeaderSelection. */
  selection?: HeaderSelection
}>()

// Phone-style on a phone or a tablet, like the app shell (useCompactUi).
const isCompact = useCompactUi()
// A page's header is its panel's UDashboardNavbar, leading on a phone or a tablet with the ☰ that opens the
// navigation; embedded in another page, the same header without that chrome.
const embedded = inject(PAGE_FRAME_KEY, 'page') === 'embedded'
/** The group panel folded away: the header's first button opens it again (never in an embedded header). */
const panelFolded = inject(PANEL_FOLDED_KEY, ref(false))
const showPanelOpen = computed(() => panelFolded.value && !embedded && !isCompact.value)
/** The ☰, with the navigation's own name - its button takes the attribute over Nuxt UI's "Open sidebar". */
const navToggle = computed(() => (isCompact.value && !embedded ? ({ 'aria-label': t('shell.mobileNav.open') } as Record<string, string>) : false))
const { t } = useI18n()
// Its documentation page (utils/docs-links.ts): a "?" at the right end, just before the object's "⋮" - after
// everything else the screen puts there (Admin_UI.md §3.8). An admin screen's, never the App's, never a header
// embedded in another page.
const route = useRoute()
const docsLink = computed(() => embedded || isAppPath(route.path) ? null : docsLinkFor(route.path))
const docsAction = computed<HeaderAction | null>(() => docsLink.value
  ? { label: t('shell.pageHeader.help'), icon: 'i-lucide-circle-help', iconOnly: true, onSelect: () => { window.open(docsLink.value!, '_blank', 'noopener') } }
  : null)
const visibleActions = computed(() => props.actions ?? [])
const objectMenu = computed(() => (props.menu ?? []).filter(group => group.length > 0))
const selecting = computed(() => (props.selection?.count ?? 0) > 0)
/** A phone while rows are selected: the header is only about the selection. */
const phoneSelecting = computed(() => isCompact.value && selecting.value)

function toMenuItem(action: HeaderAction): DropdownMenuItem {
  return {
    label: action.label,
    icon: action.icon,
    description: action.tooltip,
    color: action.color === 'neutral' ? undefined : action.color,
    disabled: action.disabled || action.loading,
    onSelect: action.onSelect,
    children: action.children
  }
}
/** Selecting on a phone: destructive bulk actions stay as icon buttons, the rest go to the "⋮". */
const selectionIconActions = computed(() => (props.selection?.actions ?? []).filter(a => a.color === 'error' && !a.children))
/** The phone's "⋮": secondary actions, then the phone-only groups, then the object's own menu - or, selecting, the non-destructive bulk actions. */
const phoneMenu = computed<DropdownMenuItem[][]>(() => {
  if (phoneSelecting.value) {
    return [(props.selection?.actions ?? []).filter(a => !selectionIconActions.value.includes(a)).map(toMenuItem)].filter(group => group.length > 0)
  }
  return [
    [...visibleActions.value, ...(docsAction.value ? [docsAction.value] : [])].map(toMenuItem),
    ...(props.mobileMenu ?? []),
    ...objectMenu.value
  ].filter(group => group.length > 0)
})

// Resolved explicitly (not just used bare in the template) - `:is` needs
// an actual component reference, not the auto-imported tag's string name.
const NuxtLink = resolveComponent('NuxtLink')
const router = useRouter()

/** The icon navigates somewhere - rendered as a Back arrow instead of the page's own icon. */
const navigable = computed(() => !!(props.iconBack || props.iconTo))

const avatarFailed = ref(false)
watch(() => props.avatar, () => {
  avatarFailed.value = false
})
const showAvatar = computed(() => !!props.avatar && !avatarFailed.value && !navigable.value)

/**
 * vue-router records the previous in-app URL in `history.state.back` -
 * it's `null` on a page opened from a direct link or in a new tab, where
 * `router.back()` would leave the admin (or do nothing). Falls back to
 * `iconTo`, then to the admin's home.
 */
function goBack() {
  if (window.history.state?.back) router.back()
  else router.push(props.iconTo ?? '/')
}
</script>

<template>
  <UDashboardNavbar
    class="page-header"
    :class="[height === 'editor' ? 'page-header--editor' : 'page-header--standard', embedded ? 'px-0 shadow-none sm:px-0' : undefined, isCompact ? 'page-header--compact' : undefined]"
    :toggle="navToggle"
  >
    <template #left>
      <!-- Selecting on a phone: "✕ N selected" in place of the title. -->
      <div
        v-if="phoneSelecting"
        class="page-header__primary flex items-center gap-2"
      >
        <UButton
          icon="i-lucide-x"
          color="neutral"
          variant="ghost"
          :aria-label="t('shell.pageHeader.clearSelection')"
          @click="selection?.onClear()"
        />
        <p class="header-title">
          {{ t('shell.pageHeader.selected', { n: selection?.count }) }}<template v-if="selection?.summary">
            · {{ selection.summary }}
          </template>
        </p>
      </div>
      <div
        v-else
        class="page-header__primary flex items-center gap-3"
      >
        <UDashboardSidebarCollapse
          v-if="showPanelOpen"
          class="-ms-1.5 shrink-0"
        />
        <!-- A navigable icon IS the Back button - it shows a Back arrow
      instead of the page's own icon, so there's no guessing that it
      goes somewhere. -->
        <component
          :is="iconBack ? 'button' : (iconTo ? NuxtLink : 'div')"
          v-if="icon"
          :type="iconBack ? 'button' : undefined"
          :aria-label="navigable ? t('common.back') : undefined"
          :to="iconBack ? undefined : iconTo"
          class="header-icon"
          :class="navigable ? 'transition-colors hover:bg-accented' : undefined"
          @click="iconBack ? goBack() : undefined"
        >
          <img
            v-if="showAvatar"
            :src="avatar!"
            alt=""
            class="size-full rounded-[inherit] object-cover"
            @error="avatarFailed = true"
          >
          <UIcon
            v-else
            :name="navigable ? 'i-lucide-arrow-left' : icon"
            class="header-icon__glyph"
          />
        </component>
        <div class="min-w-0">
          <div class="page-header__title-row">
            <h1
              class="header-title"
            >
              {{ title }}
            </h1>
            <div
              v-if="$slots.status"
              class="shrink-0"
            >
              <slot name="status" />
            </div>
          </div>
          <p
            v-if="description"
            class="header-subtitle page-header__description"
            :title="description"
          >
            {{ description }}
          </p>
        </div>
      </div>
    </template>
    <div class="page-header__center">
      <slot name="center" />
    </div>
    <template #right>
      <template v-if="phoneSelecting">
        <UButton
          v-for="(action, index) in selectionIconActions"
          :key="`selection-icon-${index}`"
          :icon="action.icon"
          :aria-label="action.label"
          :color="action.color"
          variant="ghost"
          :disabled="action.disabled"
          :loading="action.loading"
          @click="action.onSelect?.()"
        />
      </template>
      <template v-else>
        <!-- Desktop, selecting: the bulk actions come first. -->
        <template v-if="selecting && !isCompact">
          <span class="whitespace-nowrap text-sm text-muted">{{ t('shell.pageHeader.selected', { n: selection?.count }) }}<template v-if="selection?.summary"> · {{ selection.summary }}</template></span>
          <HeaderActionButton
            v-for="(action, index) in selection?.actions"
            :key="`selection-${index}`"
            :action="action"
          />
          <UButton
            :label="t('shell.pageHeader.clearSelection')"
            color="neutral"
            variant="ghost"
            @click="selection?.onClear()"
          />
          <USeparator
            orientation="vertical"
            class="mx-1 h-6"
          />
        </template>
        <slot name="search" />
        <template v-if="!isCompact">
          <HeaderActionButton
            v-for="(action, index) in visibleActions"
            :key="`action-${index}-${action.label}`"
            :action="action"
          />
          <!-- Editors: secondary actions | status and publishing. -->
          <USeparator
            v-if="height === 'editor' && visibleActions.length"
            orientation="vertical"
            class="mx-1 h-6"
          />
        </template>
        <slot />
        <HeaderActionButton
          v-if="docsAction && !isCompact"
          :action="docsAction"
        />
        <!-- Actions on the object itself (Settings…, Delete…): the "⋮" at the
        right end, after everything else. On a phone they join its one "⋮". -->
        <UDropdownMenu
          v-if="objectMenu.length && !isCompact"
          :items="objectMenu"
          :content="{ align: 'end' }"
        >
          <UButton
            icon="i-lucide-ellipsis-vertical"
            color="neutral"
            variant="ghost"
            :aria-label="t('common.actions')"
            :loading="menuLoading"
          />
        </UDropdownMenu>
      </template>
      <UDropdownMenu
        v-if="isCompact && phoneMenu.length"
        :items="phoneMenu"
        :content="{ align: 'end' }"
      >
        <UButton
          icon="i-lucide-ellipsis-vertical"
          color="neutral"
          variant="ghost"
          :aria-label="t('shell.pageHeader.moreActions')"
          :loading="menuLoading"
        />
      </UDropdownMenu>
    </template>
  </UDashboardNavbar>
</template>
