<script setup lang="ts">
/**
 * Settings > Form and the wizard's Form step (Specification_DataViews.md §3.6): how the record form opens (its mode,
 * size and side, a record page's width and fit to screen; a FORM's mode, a Master-detail's opening) and the record's
 * actions (clone, save & new, copy, print, activity, previous/next). Clone and Save & New need Allow › Create;
 * Previous/Next is a FORM's. "Design the form →" opens the Design form.
 *
 * The page or the wizard owns every value (each a `v-model`); this only shows and edits. "How it opens" is
 * DataViewOpenSettings.vue - the same controls the Design form's toolbar offers.
 */
import {
  DATAVIEW_FEATURES,
  featureDescriptionKey,
  featureLabelKey,
  type DataView,
  type EditPresentation,
  type EditSide,
  type EditSize,
  type FormViewMode,
  type MasterDetailOpenWith,
  type PageContentAlign,
  type PageContentWidth
} from '~/types/dataview'
import { useCatalogText } from '~/utils/catalog-text'

const props = defineProps<{
  dataview: Pick<DataView, 'viewType' | 'name'>
  /** The DataView's name as being edited - the New button's default label. */
  name: string
  /** Allow, as being edited - Clone and Save & New need its Create. */
  allow: readonly string[]
  /** "Design the form →" shows - a page with a form to design. */
  designable?: boolean
}>()
const emit = defineEmits<{ design: [] }>()
const featureFlags = defineModel<Record<string, boolean>>('features', { required: true })
const editPresentation = defineModel<EditPresentation>('editPresentation', { required: true })
const editSize = defineModel<EditSize | null>('editSize', { required: true })
const editSide = defineModel<EditSide>('editSide', { required: true })
const formViewMode = defineModel<FormViewMode>('formViewMode', { required: true })
const masterDetailOpenWith = defineModel<MasterDetailOpenWith>('masterDetailOpenWith', { required: true })
const newRecordLabel = defineModel<string>('newRecordLabel', { required: true })
const pageContentWidth = defineModel<PageContentWidth | null>('pageContentWidth', { required: true })
const pageContentAlign = defineModel<PageContentAlign | null>('pageContentAlign', { required: true })
const fitToScreen = defineModel<boolean>('fitToScreen', { required: true })

const { t } = useI18n()
const catalogText = useCatalogText()
const featureCatalog = computed(() => (DATAVIEW_FEATURES[props.dataview.viewType] ?? []).map(feature => ({
  ...feature,
  label: catalogText(featureLabelKey(feature), feature.label),
  description: catalogText(featureDescriptionKey(props.dataview.viewType, feature), feature.description)
})))
/** The record's actions - Previous/Next only where it means something (a FORM steps through records). */
const formFeatureCatalog = computed(() => featureCatalog.value.filter(f => f.group === 'form' && f.key !== 'search' && (f.key !== 'recordNavigation' || props.dataview.viewType === 'FORM')))
/** A FORM's record Search - how it finds another record, shown with how it opens. */
const searchFeature = computed(() => featureCatalog.value.find(f => f.group === 'form' && f.key === 'search'))
/** Clone and Save & New start a new record: they need Allow › Create. */
const NEEDS_CREATE = new Set(['recordClone', 'recordSaveAndNew'])
const locked = (key: string) => NEEDS_CREATE.has(key) && !props.allow.includes('create')
</script>

<template>
  <div class="flex flex-col gap-8">
    <SettingsSection
      :title="t('designer.formSettings.howItOpens')"
      :description="t('designer.formSettings.howItOpensDescription')"
    >
      <template #actions>
        <UButton
          v-if="designable"
          :label="t('designer.formSettings.design')"
          trailing-icon="i-lucide-arrow-right"
          color="neutral"
          variant="link"
          size="xs"
          @click="emit('design')"
        />
      </template>
      <DataViewOpenSettings
        v-model:edit-presentation="editPresentation"
        v-model:edit-size="editSize"
        v-model:edit-side="editSide"
        v-model:form-view-mode="formViewMode"
        v-model:master-detail-open-with="masterDetailOpenWith"
        v-model:new-record-label="newRecordLabel"
        v-model:page-content-width="pageContentWidth"
        v-model:page-content-align="pageContentAlign"
        v-model:fit-to-screen="fitToScreen"
        :dataview="dataview"
        :name="name"
      />

      <div
        v-if="searchFeature"
        class="flex items-center justify-between gap-2"
      >
        <div class="min-w-0">
          <p class="text-sm">
            {{ searchFeature.label }}
          </p>
          <p class="text-xs text-muted">
            {{ searchFeature.description }}
          </p>
        </div>
        <USwitch
          v-model="featureFlags[searchFeature.key]"
          :aria-label="searchFeature.label"
        />
      </div>
    </SettingsSection>

    <SettingsSection
      v-if="formFeatureCatalog.length > 0"
      :title="t('designer.formSettings.recordActions')"
      :description="t('designer.formSettings.recordActionsDescription')"
    >
      <div class="flex flex-col gap-2">
        <div
          v-for="feature in formFeatureCatalog"
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
