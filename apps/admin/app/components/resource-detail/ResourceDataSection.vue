<script setup lang="ts">
import type { Resource } from '~/types/resource'

/**
 * A resource page's Data section: a note first (why it can't be edited), its name (renamed beside it - the `rename` slot - or the hint saying where), its
 * description, its schema, then the type's own fields in the default slot (a function's class).
 */
defineProps<{
  resource: Resource
  /** Where renaming happens when this page doesn't do it. */
  renameHint?: string
}>()
const emit = defineEmits<{ 'update:resource': [resource: Resource] }>()
const { t } = useI18n()
</script>

<template>
  <SettingsSection :title="t('database.resourceDetail.data')">
    <slot name="note" />
    <div>
      <p class="text-sm font-medium mb-1">
        {{ t('common.name') }}
      </p>
      <div class="flex items-center gap-2">
        <UInput
          :aria-label="t('common.name')"
          :model-value="resource.name"
          disabled
          class="flex-1"
        />
        <slot name="rename" />
      </div>
      <p
        v-if="renameHint"
        class="text-xs text-muted mt-1"
      >
        {{ renameHint }}
      </p>
    </div>
    <ResourceDescriptionField
      :resource="resource"
      @update:resource="(next: Resource) => emit('update:resource', next)"
    />
    <div>
      <p class="text-sm font-medium mb-1">
        {{ t('database.resourceDetail.schema') }}
      </p>
      <UInput
        :aria-label="t('database.resourceDetail.schema')"
        :model-value="resource.schema"
        disabled
        class="w-full"
      />
    </div>
    <slot />
  </SettingsSection>
</template>
