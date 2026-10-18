<script setup lang="ts">
/**
 * An EXTERNALFRAME DataView's own settings - the URL, its two features
 * (EXTERNALFRAME_FEATURES) and a live preview - shared by the wizard's
 * Frame step and the settings page, so both edit the same thing the same
 * way. The preview follows the URL after a short pause, so typing doesn't
 * reload the embedded page on every keystroke.
 */
import { EXTERNALFRAME_FEATURES, featureDescriptionKey, featureLabelKey } from '~/types/dataview'
import { embeddableFrameUrl } from '~/utils/frame-url'

const url = defineModel<string>('url', { required: true })
const features = defineModel<Record<string, boolean>>('features', { required: true })
const { t } = useI18n()
const catalogText = useCatalogText()
const frameFeatures = computed(() => EXTERNALFRAME_FEATURES.map(f => ({
  ...f,
  label: catalogText(featureLabelKey(f), f.label),
  description: catalogText(featureDescriptionKey('EXTERNALFRAME', f), f.description)
})))

// The preview reloads once the URL has been still a moment, not on every keystroke.
const previewUrl = useDebouncedRef(url, 600)

const urlError = computed(() => url.value.trim() && !embeddableFrameUrl(url.value)
  ? t('designer.dataViewFrameSettings.urlError')
  : undefined)
</script>

<template>
  <div class="flex flex-col gap-4">
    <UFormField
      label="URL"
      required
      :description="t('designer.dataViewFrameSettings.urlHelp')"
      :error="urlError"
    >
      <UInput
        v-model="url"
        type="url"
        class="w-full"
      />
    </UFormField>

    <div class="rounded-lg border border-default overflow-hidden">
      <label
        v-for="feature in frameFeatures"
        :key="feature.key"
        class="flex items-center gap-3 border-b border-default px-3 py-2.5 last:border-b-0"
      >
        <div class="flex-1">
          <p class="text-sm font-medium text-highlighted">{{ feature.label }}</p>
          <p class="text-xs text-muted">{{ feature.description }}</p>
        </div>
        <USwitch v-model="features[feature.key]" />
      </label>
    </div>

    <UFormField
      :label="t('common.preview')"
      :description="t('designer.dataViewFrameSettings.previewHelp')"
    >
      <div class="flex h-96 flex-col overflow-hidden rounded-lg border border-default">
        <DataViewExternalFrame
          v-if="embeddableFrameUrl(previewUrl)"
          :url="previewUrl"
          :title="t('common.preview')"
        />
        <UEmpty
          v-else
          icon="i-lucide-app-window"
          :title="t('designer.dataViewFrameSettings.noPreview')"
          :description="t('designer.dataViewFrameSettings.noPreviewHelp')"
          variant="naked"
          class="flex-1"
        />
      </div>
    </UFormField>
  </div>
</template>
