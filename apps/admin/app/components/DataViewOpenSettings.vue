<script setup lang="ts">
/**
 * How a record form opens (DataViews.md §6.3, §6.7): a list type's mode, size and side; a FORM's mode;
 * a Master-detail's opening and its New button's label; a record page's width, alignment and fit to screen; a
 * CUSTOM page's width and alignment. One set of controls for Settings › Form (DataViewFormSettings.vue) and the
 * Design form's toolbar (CustomDesigner.vue, a popover) - the host owns every value (each a `v-model`).
 */
import {
  EDIT_PRESENTATION_META,
  EDIT_SIDE_META,
  EDIT_SIZE_META,
  FORM_LIKE_DATAVIEW_TYPES,
  FORM_VIEW_MODE_META,
  MASTER_DETAIL_OPEN_WITH_META,
  dataviewMetaKey,
  type DataView,
  type EditPresentation,
  type EditSide,
  type EditSize,
  type FormSize,
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
}>()
const editPresentation = defineModel<EditPresentation>('editPresentation', { required: true })
/** null: Default - the container's own width (`edit_size` unset). */
const editSize = defineModel<EditSize | null>('editSize', { required: true })
const sizeChoice = computed<FormSize>({
  get: () => editSize.value ?? 'default',
  set: (value) => { editSize.value = value === 'default' ? null : value }
})
const editSide = defineModel<EditSide>('editSide', { required: true })
const formViewMode = defineModel<FormViewMode>('formViewMode', { required: true })
const masterDetailOpenWith = defineModel<MasterDetailOpenWith>('masterDetailOpenWith', { required: true })
const newRecordLabel = defineModel<string>('newRecordLabel', { required: true })
const pageContentWidth = defineModel<PageContentWidth | null>('pageContentWidth', { required: true })
const pageContentAlign = defineModel<PageContentAlign | null>('pageContentAlign', { required: true })
const fitToScreen = defineModel<boolean>('fitToScreen', { required: true })

const isCustom = computed(() => props.dataview.viewType === 'CUSTOM')
/** A record page - FORM, MASTER_DETAIL, or a list whose Edit form opens on its own route (PAGE) - has the page options (DataViews.md §6.7). */
const isRecordPage = computed(() => FORM_LIKE_DATAVIEW_TYPES.includes(props.dataview.viewType) || editPresentation.value === 'PAGE')

const { t } = useI18n()
const catalogText = useCatalogText()
/** A types/dataview.ts catalog entry's text in the UI's language. */
const meta = (catalog: string, key: string, english: string, part: 'label' | 'description' = 'label') => catalogText(dataviewMetaKey(catalog, key, part), english)
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- A CUSTOM page: only its width and alignment. -->
    <DataViewPageWidthSettings
      v-if="isCustom"
      v-model:width="pageContentWidth"
      v-model:align="pageContentAlign"
      page="custom"
    />
    <template v-else>
      <template v-if="!FORM_LIKE_DATAVIEW_TYPES.includes(dataview.viewType)">
        <UFormField
          :label="t('designer.featuresSettings.mode')"
          :description="t('designer.featuresSettings.editModeDescription')"
        >
          <USelectMenu
            v-model="editPresentation"
            :items="(['DRAWER', 'MODAL', 'SIDEBAR', 'PAGE'] as const)"
            class="w-full"
          >
            <template #item-label="{ item }">
              {{ meta('editPresentations', item, EDIT_PRESENTATION_META[item as EditPresentation].label) }}
            </template>
            <template #default>
              {{ meta('editPresentations', editPresentation, EDIT_PRESENTATION_META[editPresentation].label) }}
            </template>
          </USelectMenu>
        </UFormField>

        <div
          v-if="editPresentation !== 'PAGE'"
          class="grid grid-cols-2 gap-3"
        >
          <UFormField :label="t('designer.featuresSettings.size')">
            <USelectMenu
              v-model="sizeChoice"
              :items="(['default', 'sm', 'md', 'lg', 'xl'] as const)"
              class="w-full"
            >
              <template #item-label="{ item }">
                {{ meta('editSizes', item, EDIT_SIZE_META[item as FormSize].label) }}
              </template>
              <template #default>
                {{ meta('editSizes', sizeChoice, EDIT_SIZE_META[sizeChoice].label) }}
              </template>
            </USelectMenu>
          </UFormField>

          <UFormField
            v-if="editPresentation === 'SIDEBAR'"
            :label="t('designer.featuresSettings.position')"
          >
            <USelectMenu
              v-model="editSide"
              :items="(['left', 'right', 'top', 'bottom'] as const)"
              class="w-full"
            >
              <template #item-label="{ item }">
                {{ meta('editSides', item, EDIT_SIDE_META[item as EditSide].label) }}
              </template>
              <template #default>
                {{ meta('editSides', editSide, EDIT_SIDE_META[editSide].label) }}
              </template>
            </USelectMenu>
          </UFormField>
        </div>
      </template>

      <UFormField
        v-else-if="dataview.viewType === 'FORM'"
        :label="t('designer.featuresSettings.mode')"
        :description="t('designer.featuresSettings.formModeDescription')"
      >
        <div class="flex flex-wrap gap-1.5">
          <UButton
            v-for="option in (Object.keys(FORM_VIEW_MODE_META) as FormViewMode[])"
            :key="option"
            :label="meta('formViewModes', option, FORM_VIEW_MODE_META[option].label)"
            size="xs"
            color="neutral"
            :variant="formViewMode === option ? 'solid' : 'outline'"
            @click="formViewMode = option"
          />
        </div>
        <p class="mt-1 text-xs text-muted">
          {{ meta('formViewModes', formViewMode, FORM_VIEW_MODE_META[formViewMode].description, 'description') }}
        </p>
      </UFormField>

      <template v-else-if="dataview.viewType === 'MASTER_DETAIL'">
        <UFormField
          :label="t('designer.featuresSettings.onOpen')"
          :description="t('designer.featuresSettings.onOpenDescription')"
        >
          <div class="flex flex-wrap gap-1.5">
            <UButton
              v-for="option in (Object.keys(MASTER_DETAIL_OPEN_WITH_META) as MasterDetailOpenWith[])"
              :key="option"
              :label="meta('openWith', option, MASTER_DETAIL_OPEN_WITH_META[option].label)"
              size="xs"
              color="neutral"
              :variant="masterDetailOpenWith === option ? 'solid' : 'outline'"
              @click="masterDetailOpenWith = option"
            />
          </div>
          <p class="mt-1 text-xs text-muted">
            {{ meta('openWith', masterDetailOpenWith, MASTER_DETAIL_OPEN_WITH_META[masterDetailOpenWith].description, 'description') }}
          </p>
        </UFormField>
        <UFormField
          v-if="masterDetailOpenWith === 'WAIT'"
          :label="t('designer.featuresSettings.newButtonLabel')"
          :description="t('designer.featuresSettings.newButtonLabelDescription', { name: name || dataview.name })"
        >
          <UInput
            v-model="newRecordLabel"
            class="w-full"
          />
        </UFormField>
      </template>

      <template v-if="isRecordPage">
        <DataViewPageWidthSettings
          v-model:width="pageContentWidth"
          v-model:align="pageContentAlign"
          page="record"
        />
        <div class="flex items-center justify-between gap-2">
          <div class="min-w-0">
            <p class="text-sm">
              {{ t('designer.featuresSettings.fitToScreen') }}
            </p>
            <p class="text-xs text-muted">
              {{ t('designer.featuresSettings.fitToScreenDescription') }}
            </p>
          </div>
          <USwitch
            v-model="fitToScreen"
            :aria-label="t('designer.featuresSettings.fitToScreen')"
          />
        </div>
      </template>
    </template>
  </div>
</template>
