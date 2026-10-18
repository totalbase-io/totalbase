<script setup lang="ts">
/**
 * DataViewGrid.vue's toolbar - the one row above the rows, in its two modes
 * (`mode`): 'full' (every action its own button, today's default) or
 * 'compact' (Search/Actions/New only, everything else tucked into one "⋮"
 * dropdown, Tailscale-style - the same open-state refs the full toolbar's
 * own buttons set, through the same emits, so both modes stay in sync with
 * zero duplicated logic). An embed with no toolbar (`newOnly`) keeps New alone.
 *
 * Compact mode on the standalone page moves its controls into that page's
 * own PageHeader instead (`teleport` - two targets, so the header reads
 * Search / New / ⋮, not everything bunched to one side); the row itself
 * then renders nothing here.
 *
 * Status that's normally a button badge (an active filter, a hidden-column
 * count, the current density) gets folded into each compact item's own label
 * text instead, since a dropdown item has no separate badge slot here.
 */
import type { DropdownMenuItem } from '@nuxt/ui'
import type { DataViewType, SavedView } from '~/types/dataview'
import type { ToolbarMode } from '~/composables/useGridUserPrefs'

const props = defineProps<{
  /** The toolbar on screen - the viewer's/DataView's choice, compact on a phone or a tablet. */
  mode: ToolbarMode
  /** An embed with no toolbar (`embedToolbar: 'none'`): New alone - its feature mask turns the rest off. */
  newOnly?: boolean
  /** Compact mode's controls move into the standalone page's header: the two CSS selectors (see the grid's `compactSearchTarget`). */
  teleport?: { search: string, actions: string }
  /** "New" inline - an embedded grid; the standalone page hoists it into its PageHeader. */
  showNew: boolean
  newLabel?: string
  /** The list fills its page edge to edge: the toolbar keeps a padding of its own. */
  edgeToEdge?: boolean
  /** The active view's features - which of search/filter/columns/export/print/history/import/savedViews show. */
  features: Record<string, boolean>
  views: SavedView[]
  activeViewId: string | null
  /** A view is being saved - the views menu closes once it is. */
  viewSaving: boolean
  /** The views it offers (view_config.layouts) - one button each, or an item of the "⋮" on a phone. */
  layouts: { type: DataViewType, label: string, icon: string }[]
  activeLayout: DataViewType
  /** Table-level history - needs the source's catalog id. */
  hasHistory: boolean
  densitySwitcher: boolean
  densityItems: DropdownMenuItem[]
  /** The current density's name. */
  densityLabel: string
  filterActive: boolean
  hiddenColCount: number
  canImport: boolean
  showRefresh: boolean
  /** "Refresh", or "Refresh (auto 1m)" under an auto-refresh. */
  refreshLabel: string
  /** The viewer's/DataView's own mode (not the phone's forced compact) - the Compact switch's checkbox. */
  toolbarMode: ToolbarMode
  /** No Compact switch on a phone or tablet - it's always compact there - nor where an embed fixes the toolbar. */
  canToggleToolbar: boolean
}>()
const emit = defineEmits<{
  create: []
  selectView: [id: string | null]
  switchLayout: [type: DataViewType]
  saveNewView: [name: string]
  replaceView: [id: string]
  removeView: [id: string]
  shareView: [id: string]
  openHistory: []
  openFilter: []
  openColumns: []
  openImport: []
  openExport: []
  openPrint: []
  refresh: []
  toggleToolbarMode: []
}>()
const search = defineModel<string>('search', { default: '' })
const { t } = useI18n()
/** Below md - a phone lists the views in the selector's menu (no room for their buttons). */
const isMobile = useIsMobile()

/** A full toolbar's labeled button: icon only, its word kept for a screen reader, once the toolbar is narrower than its row of words (T63). */
const TOOLBAR_BUTTON_UI = { label: '@max-[80rem]:sr-only' }
const activeLayoutOption = computed(() => props.layouts.find(l => l.type === props.activeLayout))
const menuLayouts = computed(() => (isMobile.value && props.layouts.length > 1 ? props.layouts : []))
// Inline compact toolbar (an embedded panel - the standalone page uses
// HeaderSearch): Search collapses to a bare icon until clicked - stays
// expanded (even if left empty) once opened this session, so typing
// then clearing doesn't yank the input away mid-edit.
const searchExpanded = ref(false)

/** No action at all (a Detail grid, every table feature off) - no menu: its Compact switch alone would change nothing. */
const hasMenuActions = computed(() => (actionsMenuItems.value[0]?.length ?? 0) > 0)
const actionsMenuItems = computed<DropdownMenuItem[][]>(() => {
  const items: DropdownMenuItem[] = []
  // A phone: the views are an item of the "⋮" (no room for their buttons in the header).
  if (props.layouts.length > 1 && isMobile.value) {
    items.push({
      label: t('dataviews.grid.viewMenu', { view: activeLayoutOption.value?.label ?? '' }),
      icon: activeLayoutOption.value?.icon,
      children: [props.layouts.map(l => ({ label: l.label, icon: l.icon, type: 'checkbox' as const, checked: props.activeLayout === l.type, onSelect: () => emit('switchLayout', l.type) }))]
    })
  }
  if (props.hasHistory) {
    items.push({ label: t('dataviews.recordMenu.activity'), icon: 'i-lucide-history', onSelect: () => emit('openHistory') })
  }
  if (props.densitySwitcher) {
    items.push({ label: t('dataviews.grid.densityMenu', { density: props.densityLabel }), icon: 'i-lucide-rows-3', children: [props.densityItems] })
  }
  if (props.features.filter) {
    items.push({
      label: props.filterActive ? t('dataviews.grid.filterActive') : t('dataviews.meta.featureLabels.filter'),
      icon: 'i-lucide-filter',
      onSelect: () => emit('openFilter')
    })
  }
  if (props.features.columnsToggle) {
    items.push({
      label: props.hiddenColCount ? t('dataviews.grid.columnsHidden', { count: props.hiddenColCount }) : t('dataviews.meta.featureLabels.columnsToggle'),
      icon: 'i-lucide-columns-3',
      onSelect: () => emit('openColumns')
    })
  }
  if (props.canImport) {
    items.push({ label: t('dataviews.meta.featureLabels.import'), icon: 'i-lucide-upload', onSelect: () => emit('openImport') })
  }
  if (props.features.export) {
    items.push({ label: t('dataviews.meta.featureLabels.export'), icon: 'i-lucide-download', onSelect: () => emit('openExport') })
  }
  if (props.features.print) {
    items.push({ label: t('dataviews.meta.featureLabels.print'), icon: 'i-lucide-printer', onSelect: () => emit('openPrint') })
  }
  if (props.showRefresh) {
    items.push({ label: props.refreshLabel, icon: 'i-lucide-refresh-cw', onSelect: () => emit('refresh') })
  }
  if (!props.canToggleToolbar) return [items]
  return [
    items,
    [{ label: t('dataviews.grid.compact'), icon: 'i-lucide-shrink', type: 'checkbox' as const, checked: props.toolbarMode === 'compact', onSelect: () => emit('toggleToolbarMode') }]
  ]
})
</script>

<template>
  <!-- Compact mode, standalone only: Search (HeaderSearch - the input on
  desktop, an icon opening it over the header on a phone) moves before
  New, the "⋮" actions menu after it (New already lives there, unconditionally -
  see pages/app/dataviews/[slug]/index.vue's two target divs). -->
  <template v-if="teleport">
    <Teleport :to="teleport.search">
      <DataViewSavedViewsMenu
        v-if="features.savedViews"
        :views="views"
        :active-id="activeViewId"
        :saving="viewSaving"
        :layouts="menuLayouts"
        :active-layout="activeLayout"
        @select="emit('selectView', $event)"
        @layout="emit('switchLayout', $event)"
        @save-new="emit('saveNewView', $event)"
        @replace="emit('replaceView', $event)"
        @remove="emit('removeView', $event)"
        @share="emit('shareView', $event)"
      />
      <!-- Its view types after the saved views - a phone has them in the saved views' menu. -->
      <UFieldGroup
        v-if="layouts.length > 1"
        class="max-md:hidden"
      >
        <UTooltip
          v-for="option in layouts"
          :key="option.type"
          :text="option.label"
        >
          <UButton
            :icon="option.icon"
            color="neutral"
            :variant="activeLayout === option.type ? 'solid' : 'outline'"
            :aria-label="option.label"
            :aria-pressed="activeLayout === option.type"
            @click="emit('switchLayout', option.type)"
          />
        </UTooltip>
      </UFieldGroup>
      <HeaderSearch
        v-if="features.search"
        v-model="search"
      >
        <template
          v-if="features.filter"
          #trailing
        >
          <UTooltip :text="t('dataviews.meta.featureLabels.filter')">
            <UButton
              icon="i-lucide-filter"
              color="neutral"
              variant="link"
              size="sm"
              :padded="false"
              :aria-label="t('dataviews.meta.featureLabels.filter')"
              @click="emit('openFilter')"
            />
          </UTooltip>
        </template>
      </HeaderSearch>
    </Teleport>
    <Teleport :to="teleport.actions">
      <UDropdownMenu
        v-if="hasMenuActions"
        :items="actionsMenuItems"
      >
        <UButton
          icon="i-lucide-ellipsis-vertical"
          color="neutral"
          variant="ghost"
          :aria-label="t('common.actions')"
        />
      </UDropdownMenu>
    </Teleport>
  </template>

  <!-- A container: its own width, not the window's, decides when the full toolbar's buttons drop their words. -->
  <div
    v-else-if="!newOnly || showNew"
    class="@container flex gap-3"
    :class="[mode === 'compact' ? 'items-center' : 'flex-col sm:flex-row sm:flex-wrap sm:items-center', edgeToEdge ? 'px-3 pt-3' : undefined]"
  >
    <!-- Standalone: "New" lives in the page's PageHeader instead (see the grid's `layout` prop) - this stays for the embedded default. -->
    <UButton
      v-if="showNew"
      icon="i-lucide-plus"
      :label="newLabel || t('common.new')"
      @click="emit('create')"
    />
    <!-- An embed with no toolbar: New alone. -->
    <template v-if="newOnly" />
    <!-- Compact: saved views, the view types (view_config.layouts, one button each), search, New, the "⋮". -->
    <template v-else-if="mode === 'compact'">
      <DataViewSavedViewsMenu
        v-if="features.savedViews"
        :views="views"
        :active-id="activeViewId"
        :saving="viewSaving"
        :layouts="menuLayouts"
        :active-layout="activeLayout"
        @select="emit('selectView', $event)"
        @layout="emit('switchLayout', $event)"
        @save-new="emit('saveNewView', $event)"
        @replace="emit('replaceView', $event)"
        @remove="emit('removeView', $event)"
        @share="emit('shareView', $event)"
      />
      <UFieldGroup
        v-if="layouts.length > 1"
        class="shrink-0"
      >
        <UTooltip
          v-for="option in layouts"
          :key="option.type"
          :text="option.label"
        >
          <UButton
            :icon="option.icon"
            color="neutral"
            :variant="activeLayout === option.type ? 'solid' : 'outline'"
            :aria-label="option.label"
            :aria-pressed="activeLayout === option.type"
            @click="emit('switchLayout', option.type)"
          />
        </UTooltip>
      </UFieldGroup>
    </template>

    <!-- Compact mode: Search (icon until clicked, with a trailing shortcut
    into Filter), New already handled above/hoisted, "⋮" for everything else. -->
    <template v-if="mode === 'compact'">
      <UButton
        v-if="features.search && !searchExpanded"
        icon="i-lucide-search"
        color="neutral"
        variant="ghost"
        :aria-label="t('common.search')"
        @click="searchExpanded = true"
      />
      <UInput
        v-if="features.search && searchExpanded"
        v-model="search"
        :aria-label="t('dataviews.search.placeholder')"
        icon="i-lucide-search"
        :placeholder="t('dataviews.search.placeholder')"
        autofocus
        class="w-full sm:w-72"
      >
        <template
          v-if="features.filter"
          #trailing
        >
          <UTooltip :text="t('dataviews.meta.featureLabels.filter')">
            <UButton
              icon="i-lucide-filter"
              color="neutral"
              variant="link"
              size="sm"
              :padded="false"
              :aria-label="t('dataviews.meta.featureLabels.filter')"
              @click="emit('openFilter')"
            />
          </UTooltip>
        </template>
      </UInput>
      <div class="flex-1" />
      <UDropdownMenu
        v-if="hasMenuActions"
        :items="actionsMenuItems"
      >
        <UButton
          icon="i-lucide-ellipsis-vertical"
          color="neutral"
          variant="ghost"
          :aria-label="t('common.actions')"
        />
      </UDropdownMenu>
    </template>

    <!-- Full mode: today's row - every action its own button. -->
    <template v-else>
      <UInput
        v-if="features.search"
        v-model="search"
        :aria-label="t('dataviews.search.placeholder')"
        icon="i-lucide-search"
        :placeholder="t('dataviews.search.placeholder')"
        class="w-full sm:w-72"
      />
      <!-- Full: search, the saved views, history beside them, then the view types. -->
      <DataViewSavedViewsMenu
        v-if="features.savedViews"
        :views="views"
        :active-id="activeViewId"
        :saving="viewSaving"
        :layouts="menuLayouts"
        :active-layout="activeLayout"
        @select="emit('selectView', $event)"
        @layout="emit('switchLayout', $event)"
        @save-new="emit('saveNewView', $event)"
        @replace="emit('replaceView', $event)"
        @remove="emit('removeView', $event)"
        @share="emit('shareView', $event)"
      />
      <UTooltip
        v-if="hasHistory"
        :text="t('dataviews.recordMenu.activity')"
      >
        <UButton
          icon="i-lucide-history"
          color="neutral"
          variant="outline"
          :aria-label="t('dataviews.recordMenu.activity')"
          @click="emit('openHistory')"
        />
      </UTooltip>
      <UFieldGroup
        v-if="layouts.length > 1"
        class="shrink-0"
      >
        <UTooltip
          v-for="option in layouts"
          :key="option.type"
          :text="option.label"
        >
          <UButton
            :icon="option.icon"
            color="neutral"
            :variant="activeLayout === option.type ? 'solid' : 'outline'"
            :aria-label="option.label"
            :aria-pressed="activeLayout === option.type"
            @click="emit('switchLayout', option.type)"
          />
        </UTooltip>
      </UFieldGroup>

      <div class="flex-1" />

      <!-- Row density - viewer-local only, changes just UTable's own
      td/th padding/font size (DENSITY_META), never row content. -->
      <UDropdownMenu
        v-if="densitySwitcher"
        :items="[densityItems]"
      >
        <UButton
          icon="i-lucide-rows-3"
          :label="densityLabel"
          :ui="TOOLBAR_BUTTON_UI"
          color="neutral"
          variant="subtle"
        />
      </UDropdownMenu>
      <UButton
        v-if="features.filter"
        icon="i-lucide-filter"
        :label="t('dataviews.meta.featureLabels.filter')"
        :ui="TOOLBAR_BUTTON_UI"
        color="neutral"
        variant="subtle"
        :badge="filterActive ? '•' : undefined"
        @click="emit('openFilter')"
      />
      <UButton
        v-if="features.columnsToggle"
        icon="i-lucide-columns-3"
        :label="t('dataviews.meta.featureLabels.columnsToggle')"
        :ui="TOOLBAR_BUTTON_UI"
        color="neutral"
        variant="subtle"
        :badge="hiddenColCount || undefined"
        @click="emit('openColumns')"
      />
      <UButton
        v-if="canImport"
        icon="i-lucide-upload"
        :label="t('dataviews.meta.featureLabels.import')"
        :ui="TOOLBAR_BUTTON_UI"
        color="neutral"
        variant="subtle"
        @click="emit('openImport')"
      />
      <UButton
        v-if="features.export"
        icon="i-lucide-download"
        :label="t('dataviews.meta.featureLabels.export')"
        :ui="TOOLBAR_BUTTON_UI"
        color="neutral"
        variant="subtle"
        @click="emit('openExport')"
      />
      <UButton
        v-if="features.print"
        icon="i-lucide-printer"
        :label="t('dataviews.meta.featureLabels.print')"
        :ui="TOOLBAR_BUTTON_UI"
        color="neutral"
        variant="subtle"
        @click="emit('openPrint')"
      />
      <UButton
        v-if="showRefresh"
        icon="i-lucide-refresh-cw"
        :label="refreshLabel"
        :ui="TOOLBAR_BUTTON_UI"
        color="neutral"
        variant="subtle"
        @click="emit('refresh')"
      />
      <UDropdownMenu
        v-if="hasMenuActions && canToggleToolbar"
        :items="[[{ label: t('dataviews.grid.compact'), icon: 'i-lucide-shrink', type: 'checkbox', checked: false, onSelect: () => emit('toggleToolbarMode') }]]"
      >
        <UButton
          icon="i-lucide-ellipsis-vertical"
          color="neutral"
          variant="ghost"
          :aria-label="t('dataviews.grid.toolbarOptions')"
        />
      </UDropdownMenu>
    </template>
  </div>
</template>
