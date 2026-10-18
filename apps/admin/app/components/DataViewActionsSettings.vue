<script setup lang="ts">
/**
 * Settings > Actions and the wizard's Actions step (Specification_DataViews.md §3.6) - what a viewer can do: Allow on
 * top (Create, Edit, Delete - what the DataView lets its viewers do, never more than their permissions; it isn't a
 * permission and applies on publish), then the toolbar's buttons (search, saved views, activity, filter, import,
 * export, refresh). Import needs Allow › Create. The page or the wizard owns the values (each a `v-model`).
 */
import { DATAVIEW_FEATURES, LIST_DATAVIEW_TYPES, featureDescriptionKey, featureLabelKey, isListCommonFeature, type DataViewType } from '~/types/dataview'
import { useCatalogText } from '~/utils/catalog-text'

const props = defineProps<{
  viewType: DataViewType
  /** Over a table - Allow applies; over a view nothing is written. */
  writable: boolean
}>()
const allow = defineModel<string[]>('allow', { required: true })
const featureFlags = defineModel<Record<string, boolean>>('features', { required: true })

const { t } = useI18n()
const catalogText = useCatalogText()
const ALLOW_ACTIONS = ['create', 'update', 'delete'] as const
function setAllowed(action: string, on: boolean) {
  allow.value = ALLOW_ACTIONS.filter(a => (a === action ? on : allow.value.includes(a)))
}
const isList = computed(() => LIST_DATAVIEW_TYPES.includes(props.viewType))
/** The toolbar's buttons - a list's common ones; a SETTINGS DataView's search box. */
const toolbarFeatures = computed(() => (DATAVIEW_FEATURES[props.viewType] ?? [])
  .filter(f => f.group === 'table' && (!isList.value || isListCommonFeature(f)))
  .map(f => ({ ...f, label: catalogText(featureLabelKey(f), f.label), description: catalogText(featureDescriptionKey(props.viewType, f), f.description) })))
/** A feature that needs Allow › Create: off and locked without it. */
const NEEDS_CREATE = new Set(['import'])
const locked = (key: string) => NEEDS_CREATE.has(key) && !allow.value.includes('create')
</script>

<template>
  <div class="flex flex-col gap-8">
    <SettingsSection
      v-if="writable"
      id="allow"
      :title="t('designer.settingsPage.allow')"
      :description="t('designer.settingsPage.allowDescription')"
    >
      <div class="flex flex-wrap gap-4">
        <UCheckbox
          v-for="action in ALLOW_ACTIONS"
          :key="action"
          :model-value="allow.includes(action)"
          :label="t(`designer.inspector.allow.${action}`)"
          @update:model-value="(on: boolean | 'indeterminate') => setAllowed(action, on === true)"
        />
      </div>
    </SettingsSection>

    <SettingsSection
      v-if="toolbarFeatures.length > 0"
      :title="t('designer.featuresSettings.toolbar')"
      :description="t('designer.actionsSettings.toolbarDescription')"
    >
      <div class="flex flex-col gap-2">
        <div
          v-for="feature in toolbarFeatures"
          :key="feature.key"
          class="flex items-center justify-between gap-2"
          :class="locked(feature.key) ? 'opacity-60' : undefined"
        >
          <div class="min-w-0">
            <p class="text-sm">
              {{ feature.label }}
            </p>
            <p class="text-xs text-muted">
              {{ locked(feature.key) ? t('designer.actionsSettings.requiresCreate') : feature.description }}
            </p>
          </div>
          <USwitch
            :model-value="featureFlags[feature.key] !== false && !locked(feature.key)"
            :disabled="locked(feature.key)"
            :aria-label="feature.label"
            @update:model-value="(on: boolean) => (featureFlags[feature.key] = on)"
          />
        </div>
      </div>
    </SettingsSection>
  </div>
</template>
