<script setup lang="ts">
/**
 * A page's Content width and Content align (Specification_DataViews.md §6.7) -
 * a record page's (Form features) or a CUSTOM page's (its Page section). Null
 * is Default: the instance's (Settings > DataViews > Page width), so changing
 * that setting reaches every DataView left on it.
 */
import { PAGE_CONTENT_ALIGN_META, PAGE_CONTENT_WIDTH_META, type PageContentAlign, type PageContentWidth } from '~/types/dataview'

const width = defineModel<PageContentWidth | null>('width', { required: true })
const align = defineModel<PageContentAlign | null>('align', { required: true })
defineProps<{ page: 'record' | 'custom' }>()

const { t } = useI18n()
const catalogText = useCatalogText()
const meta = (group: string, key: string, english: string) => catalogText(`dataviews.meta.${group}.${key}.label`, english)
const WIDTHS = Object.keys(PAGE_CONTENT_WIDTH_META) as PageContentWidth[]
const ALIGNS = Object.keys(PAGE_CONTENT_ALIGN_META) as PageContentAlign[]
</script>

<template>
  <UFormField
    :label="t('designer.featuresSettings.contentWidth')"
    :description="page === 'custom' ? t('designer.featuresSettings.contentWidthCustomDescription') : t('designer.featuresSettings.contentWidthDescription')"
  >
    <div class="flex flex-wrap gap-1.5">
      <UButton
        :label="t('designer.featuresSettings.instanceDefault')"
        size="xs"
        color="neutral"
        :variant="width === null ? 'solid' : 'outline'"
        @click="width = null"
      />
      <UButton
        v-for="option in WIDTHS"
        :key="option"
        :label="meta('pageContentWidths', option, PAGE_CONTENT_WIDTH_META[option].label)"
        size="xs"
        color="neutral"
        :variant="width === option ? 'solid' : 'outline'"
        @click="width = option"
      />
    </div>
  </UFormField>
  <UFormField
    v-if="width !== 'full'"
    :label="t('designer.featuresSettings.contentAlign')"
    :description="t('designer.featuresSettings.contentAlignDescription')"
  >
    <div class="flex flex-wrap gap-1.5">
      <UButton
        :label="t('designer.featuresSettings.instanceDefault')"
        size="xs"
        color="neutral"
        :variant="align === null ? 'solid' : 'outline'"
        @click="align = null"
      />
      <UButton
        v-for="option in ALIGNS"
        :key="option"
        :label="meta('pageContentAligns', option, PAGE_CONTENT_ALIGN_META[option].label)"
        size="xs"
        color="neutral"
        :variant="align === option ? 'solid' : 'outline'"
        @click="align = option"
      />
    </div>
  </UFormField>
</template>
