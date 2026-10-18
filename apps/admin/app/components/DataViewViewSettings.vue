<script setup lang="ts">
/**
 * One list view's content in Settings > Views (Specification_DataViews.md §3.6, §5.13), inside its row of the views
 * accordion (DataViewViewsAccordion.vue): its layout (the page's own settings component, in the default slot) and its
 * own controls - a table's density, columns, print and row edit, the cards' size. Whether it's offered, its place and
 * the defaults every view shares are the accordion's and Presentation's.
 *
 * The page owns every value and saves them with its settings (a `v-model`); this only shows and edits.
 */
import { DATAVIEW_FEATURES, LIST_VIEW_OWN_FEATURES, featureDescriptionKey, featureLabelKey, type DataViewType } from '~/types/dataview'
import { useCatalogText } from '~/utils/catalog-text'

const props = defineProps<{ type: DataViewType }>()
const featureFlags = defineModel<Record<string, boolean>>('features', { required: true })

const { t } = useI18n()
const catalogText = useCatalogText()
/** This view's own switches - its type's catalog, not the creation type's. */
const ownFeatures = computed(() => {
  const own = LIST_VIEW_OWN_FEATURES[props.type] ?? []
  return (DATAVIEW_FEATURES[props.type] ?? []).filter(f => own.includes(f.key)).map(feature => ({
    ...feature,
    label: catalogText(featureLabelKey(feature), feature.label),
    description: catalogText(featureDescriptionKey(props.type, feature), feature.description)
  }))
})
</script>

<template>
  <div class="flex flex-col gap-8">
    <!-- The view's layout - the page's own settings component for it. -->
    <slot />

    <SettingsSection
      v-if="ownFeatures.length > 0"
      :title="t('designer.layoutViews.controls')"
    >
      <div class="flex flex-col gap-2">
        <div
          v-for="feature in ownFeatures"
          :key="feature.key"
          class="flex items-center justify-between gap-2"
        >
          <div class="min-w-0">
            <p class="text-sm">
              {{ feature.label }}
            </p>
            <p class="text-xs text-muted">
              {{ feature.description }}
            </p>
          </div>
          <USwitch
            v-model="featureFlags[feature.key]"
            :aria-label="feature.label"
          />
        </div>
      </div>
    </SettingsSection>
  </div>
</template>
