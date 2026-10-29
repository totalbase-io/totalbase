<script setup lang="ts">
/**
 * The DataViews rail group's own nav panel (layouts/default.vue's aside,
 * `activeGroupKey === 'dataviews'`) - one flat list, A to Z, with search,
 * a type filter and each row's type as a badge on the right (grouping by
 * type left a header per type, most holding a single DataView). A leaf
 * click jumps straight to its settings page.
 *
 * The icon keeps the DataView's own icon and color (its identity, as in
 * the App menu). On the right: the type as a small muted icon (tooltip:
 * the type's name - lighter than a badge, and always there so the column
 * lines up), then the versioning status badge - Live/Changes/Draft, the
 * same as the Dashboards and Workflows sidebars (utils/publish-status.ts).
 *
 * Data source: `useAppsNavDataViews()` - the same global/shared list
 * already backing the rail's "App" group, not a separate fetch.
 *
 * Its own New DataView, as the Dashboards and Workflows sidebars have - the
 * wizard opens from any DataView, no trip back to the empty page.
 */
import { DATAVIEW_TYPE_META, DATAVIEW_TYPES, dataviewMetaKey, type DataView, type DataViewType } from '~/types/dataview'
import { identityIconStyle, publishStatus, PUBLISH_STATUS_META } from '~/utils/publish-status'
import { useCatalogText } from '~/utils/catalog-text'
import { brokenDataViewLine, useBrokenReferences } from '~/composables/useBrokenReferences'

const { dataviews, error, refresh } = useAppsNavDataViews()
// What a DataView names that PostgreSQL no longer has - an error icon on its row (DataViews.md §4.8).
const broken = useBrokenReferences()
onMounted(broken.ensure)
function brokenText(id: string): string | null {
  const problems = broken.dataviewProblems.value.get(id)
  if (!problems?.length) return null
  return t('dataviews.tree.brokenReferences', { what: problems.map(p => brokenDataViewLine(p, t('dataviews.tree.sourceGone'))).join(', ') })
}
const { t } = useI18n()
const catalogText = useCatalogText()
/** A type's name in the UI's language. */
const typeLabel = (type: DataViewType) => catalogText(dataviewMetaKey('types', type, 'label'), DATAVIEW_TYPE_META[type].label)

const wizardOpen = ref(false)
// The wizard loads on first open, then stays mounted.
const wizardMounted = useOpenedOnce(wizardOpen)
async function onCreated(dataview: DataView) {
  await refresh()
  openDataview(dataview.id)
}

const search = ref('')
const typeFilter = ref<DataViewType | 'ALL'>('ALL')

/** Only types that have at least one DataView - an empty choice is noise. */
const typeOptions = computed(() => [
  { label: t('dataviews.tree.allTypes'), value: 'ALL' as const },
  ...DATAVIEW_TYPES
    .filter(type => (dataviews.value ?? []).some(d => d.viewType === type))
    .map(type => ({ label: typeLabel(type), value: type }))
])
/** The "⋮": every type with at least one DataView, the chosen one checked. */
const typeMenuItems = computed(() => [[
  { type: 'label' as const, label: t('common.type') },
  ...typeOptions.value.map(option => ({
    label: option.label,
    icon: option.value === 'ALL' ? 'i-lucide-list' : DATAVIEW_TYPE_META[option.value].icon,
    type: 'checkbox' as const,
    checked: typeFilter.value === option.value,
    onUpdateChecked: () => { typeFilter.value = option.value }
  }))
]])
// A filter on a type whose last DataView was deleted would show nothing.
watch(typeOptions, (options) => {
  if (!options.some(o => o.value === typeFilter.value)) typeFilter.value = 'ALL'
})

const dataviewsFiltered = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  return (dataviews.value ?? [])
    .filter(d => typeFilter.value === 'ALL' || d.viewType === typeFilter.value)
    .filter(d => !query || d.name.toLocaleLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name))
})

const surfaceTone = useSurfaceTone()

function openDataview(id: string) {
  usePagePreferences('dataviews-navigation', { lastId: null as string | null }).lastId = id
  navigateTo(`/dataviews/${id}/settings`)
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <UButton
      icon="i-lucide-plus"
      :label="t('dataviews.tree.newDataView')"
      block
      @click="wizardOpen = true"
    />
    <LazyDataViewWizardModal
      v-if="wizardMounted"
      v-model:open="wizardOpen"
      @created="onCreated"
    />
    <div class="flex items-center gap-1">
      <UInput
        v-model="search"
        icon="i-lucide-search"
        :aria-label="t('dataviews.tree.searchAria')"
        :placeholder="t('dataviews.tree.searchPlaceholder')"
        class="min-w-0 flex-1"
      />
      <!-- The type filter, in the "⋮" - highlighted while it narrows the list. -->
      <UDropdownMenu
        v-if="typeOptions.length > 2"
        :items="typeMenuItems"
        :content="{ align: 'end' }"
      >
        <UButton
          icon="i-lucide-ellipsis-vertical"
          :color="typeFilter === 'ALL' ? 'neutral' : 'primary'"
          :variant="typeFilter === 'ALL' ? 'ghost' : 'soft'"
          :aria-label="typeFilter === 'ALL' ? t('dataviews.tree.filterByType') : t('dataviews.tree.filteredBy', { type: typeLabel(typeFilter) })"
        />
      </UDropdownMenu>
    </div>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="t('dataviews.tree.loadError')"
    />
    <div
      v-else
      class="flex flex-col"
    >
      <button
        v-for="dataview in dataviewsFiltered"
        :key="dataview.id"
        type="button"
        class="flex min-w-0 items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-elevated hover:text-highlighted"
        :class="PUBLISH_STATUS_META[publishStatus(dataview)].name"
        @click="openDataview(dataview.id)"
      >
        <UIcon
          :name="dataview.icon || DATAVIEW_TYPE_META[dataview.viewType].icon"
          class="size-4 shrink-0 text-muted"
          :style="identityIconStyle(dataview.color, surfaceTone)"
        />
        <span class="truncate">{{ dataview.name }}</span>
        <UTooltip
          v-if="brokenText(dataview.id)"
          :text="brokenText(dataview.id)!"
          class="shrink-0"
        >
          <UIcon
            name="i-lucide-triangle-alert"
            class="size-3.5 shrink-0 text-error"
            :aria-label="brokenText(dataview.id)!"
          />
        </UTooltip>
        <span class="sr-only">({{ typeLabel(dataview.viewType) }}, {{ t(PUBLISH_STATUS_META[publishStatus(dataview)].labelKey) }}{{ dataview.scope === 'EMBEDDED_ONLY' ? t('dataviews.tree.notInMenuSuffix') : '' }})</span>
        <UTooltip
          v-if="dataview.scope === 'EMBEDDED_ONLY'"
          :text="t('dataviews.tree.notInMenu')"
          class="ms-auto shrink-0"
        >
          <UIcon
            name="i-lucide-eye-off"
            class="size-3.5 shrink-0 text-dimmed"
          />
        </UTooltip>
        <UTooltip
          :text="typeLabel(dataview.viewType)"
          :class="dataview.scope === 'EMBEDDED_ONLY' ? 'shrink-0' : 'ms-auto shrink-0'"
        >
          <UIcon
            :name="DATAVIEW_TYPE_META[dataview.viewType].icon"
            class="size-3.5 shrink-0 text-dimmed"
          />
        </UTooltip>
        <UTooltip
          :text="t(PUBLISH_STATUS_META[publishStatus(dataview)].labelKey)"
          class="shrink-0"
        >
          <UBadge
            :label="t(PUBLISH_STATUS_META[publishStatus(dataview)].shortKey)"
            :color="PUBLISH_STATUS_META[publishStatus(dataview)].badge"
            variant="subtle"
            size="sm"
            class="shrink-0"
          />
        </UTooltip>
      </button>
      <p
        v-if="dataviewsFiltered.length === 0"
        class="px-2 py-2 text-xs text-muted"
      >
        {{ t('dataviews.tree.empty') }}
      </p>
    </div>
  </div>
</template>
