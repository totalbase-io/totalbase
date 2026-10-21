<script setup lang="ts">
/**
 * Settings > Views, on top, and the wizard's Views step (DataViews.md §3.6): how the list shows,
 * whichever view - the density and page size a first-time viewer starts with (a table's and the cards'), the
 * toolbar's default mode, the list's margin and the auto-refresh. None of them is an action. The page or the wizard
 * owns the values (each a `v-model`).
 */
import { AUTO_REFRESH_PRESETS, PAGE_SIZE_OPTIONS, dataviewMetaKey } from '~/types/dataview'
import { useCatalogText } from '~/utils/catalog-text'
import { SELECT_NONE, selectNone } from '~/utils/select-none'

defineProps<{
  /** A table or cards among its views - they have a density and a page size. */
  paged: boolean
  /** A list - it has a toolbar and a margin; a SETTINGS DataView only refreshes. */
  list: boolean
}>()
const defaultDensity = defineModel<string>('defaultDensity', { required: true })
const defaultDensitySelect = selectNone(defaultDensity)
const defaultPageSize = defineModel<number>('defaultPageSize', { required: true })
/** `default_state.toolbarMode` - '' leaves it to the instance's default. */
const defaultToolbarMode = defineModel<string>('defaultToolbarMode', { required: true })
const defaultToolbarModeSelect = selectNone(defaultToolbarMode)
/** `view_config.list_margin` - '' is the instance's. */
const listMargin = defineModel<string>('listMargin', { required: true })
const listMarginSelect = selectNone(listMargin)
/** One of AUTO_REFRESH_PRESETS' values ('off', 'custom' = autoRefreshCustom, else a preset duration). */
const autoRefreshPreset = defineModel<string>('autoRefreshPreset', { required: true })
const autoRefreshCustom = defineModel<string>('autoRefreshCustom', { required: true })

const { t } = useI18n()
const catalogText = useCatalogText()
const meta = (catalog: string, key: string, english: string) => catalogText(dataviewMetaKey(catalog, key, 'label'), english)
const DENSITY_OPTIONS = computed(() => [
  { value: SELECT_NONE, label: t('designer.featuresSettings.runtimeDefault', { value: meta('densities', 'normal', 'Normal') }) },
  { value: 'normal', label: meta('densities', 'normal', 'Normal') },
  { value: 'compact', label: meta('densities', 'compact', 'Compact') },
  { value: 'tiny', label: meta('densities', 'tiny', 'Very compact') }
])
const PAGE_SIZE_SELECT_OPTIONS = computed(() => [
  { value: 0, label: t('designer.featuresSettings.runtimeDefault', { value: 20 }) },
  ...PAGE_SIZE_OPTIONS.map(n => ({ value: n, label: String(n) }))
])
const TOOLBAR_MODE_OPTIONS = computed(() => [
  { value: SELECT_NONE, label: t('designer.featuresSettings.toolbarInstance') },
  { value: 'full', label: t('designer.featuresSettings.toolbarFull') },
  { value: 'compact', label: t('designer.featuresSettings.toolbarCompact') }
])
const LIST_MARGIN_OPTIONS = computed(() => [
  { value: SELECT_NONE, label: t('designer.featuresSettings.instanceDefault') },
  { value: 'none', label: t('designer.featuresSettings.listMargins.none') },
  { value: 'compact', label: t('designer.featuresSettings.listMargins.compact') },
  { value: 'normal', label: t('designer.featuresSettings.listMargins.normal') }
])
const AUTO_REFRESH_ITEMS = computed(() => AUTO_REFRESH_PRESETS.map(p => ({ ...p, label: catalogText(`dataviews.meta.autoRefresh.${p.value}`, p.label) })))
</script>

<template>
  <SettingsSection
    :title="t('designer.presentationSettings.heading')"
    :description="t('designer.presentationSettings.description')"
  >
    <div class="flex flex-col gap-2">
      <UFormField
        v-if="paged"
        :label="t('designer.featuresSettings.defaultDensity')"
        :description="t('designer.featuresSettings.firstTimeViewer')"
        orientation="horizontal"
        :ui="{ container: 'w-56' }"
      >
        <USelectMenu
          v-model="defaultDensitySelect"
          :items="DENSITY_OPTIONS"
          value-key="value"
          class="w-full"
        />
      </UFormField>
      <UFormField
        v-if="paged"
        :label="t('designer.featuresSettings.defaultPageSize')"
        :description="t('designer.featuresSettings.firstTimeViewer')"
        orientation="horizontal"
        :ui="{ container: 'w-56' }"
      >
        <USelectMenu
          v-model="defaultPageSize"
          :items="PAGE_SIZE_SELECT_OPTIONS"
          value-key="value"
          class="w-full"
        />
      </UFormField>
      <UFormField
        v-if="list"
        :label="t('designer.featuresSettings.defaultToolbar')"
        :description="t('designer.featuresSettings.defaultToolbarHelp')"
        orientation="horizontal"
        :ui="{ container: 'w-56' }"
      >
        <USelectMenu
          v-model="defaultToolbarModeSelect"
          :items="TOOLBAR_MODE_OPTIONS"
          value-key="value"
          class="w-full"
        />
      </UFormField>
      <UFormField
        v-if="list"
        :label="t('designer.featuresSettings.listMargin')"
        :description="t('designer.featuresSettings.listMarginHelp')"
        orientation="horizontal"
        :ui="{ container: 'w-56' }"
      >
        <USelectMenu
          v-model="listMarginSelect"
          :items="LIST_MARGIN_OPTIONS"
          value-key="value"
          class="w-full"
        />
      </UFormField>
      <UFormField
        :label="t('designer.featuresSettings.autoRefresh')"
        :description="t('designer.featuresSettings.autoRefreshDescription')"
        orientation="horizontal"
        :ui="{ container: 'w-56' }"
      >
        <div class="flex gap-2">
          <USelectMenu
            v-model="autoRefreshPreset"
            :items="AUTO_REFRESH_ITEMS"
            value-key="value"
            class="w-40"
          />
          <UInput
            v-if="autoRefreshPreset === 'custom'"
            v-model="autoRefreshCustom"
            :aria-label="t('designer.featuresSettings.customInterval')"
            class="flex-1"
          />
        </div>
      </UFormField>
    </div>
  </SettingsSection>
</template>
