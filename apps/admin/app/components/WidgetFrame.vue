<script setup lang="ts">
/**
 * The Frame widget (`TFrame`, DataViews.md §9.7): another
 * site's page in the same fixed sandbox as an EXTERNALFRAME DataView
 * (DataViewExternalFrame.vue). Its URL arrives resolved - the page's values
 * filled in and encoded by WidgetRenderer - or null: no URL for this record
 * yet. On the Design canvas it shows its template instead of loading it.
 */
const props = defineProps<{
  url?: string | null
  title?: string
  openInNewTab?: boolean
  /** The Design canvas: the template, shown instead of the page. */
  template?: string
}>()

const { t } = useI18n()
const cat = useDesignerCatalogText()

function openTab() {
  if (props.url) window.open(props.url, '_blank', 'noopener,noreferrer')
}
</script>

<template>
  <div class="flex size-full min-h-0 flex-col gap-1">
    <div
      v-if="openInNewTab && url"
      class="flex justify-end"
    >
      <UButton
        :label="t('dataviews.widgetFrame.openInNewTab')"
        icon="i-lucide-external-link"
        size="xs"
        color="neutral"
        variant="ghost"
        @click="openTab"
      />
    </div>
    <UEmpty
      v-if="template !== undefined"
      icon="i-lucide-app-window"
      :title="cat.widgetLabel('TFrame', 'Frame')"
      :description="template || t('dataviews.widgetFrame.noUrlYet')"
      variant="naked"
      class="flex-1 break-all"
    />
    <DataViewExternalFrame
      v-else-if="url"
      :url="url"
      :title="title || t('dataviews.widgetFrame.externalPage')"
    />
    <UEmpty
      v-else
      icon="i-lucide-app-window"
      :title="t('dataviews.widgetFrame.noUrlTitle')"
      :description="t('dataviews.widgetFrame.noUrlDescription')"
      variant="naked"
      class="flex-1"
    />
  </div>
</template>
