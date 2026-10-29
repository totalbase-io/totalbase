<script setup lang="ts">
/**
 * The UUID field (TUuidInput, DataViews.md §16.1): a text field a UUID is typed or pasted into, with an icon inside
 * it - where a password field has its eye - that generates a new one in its format: random (v4) or time-ordered
 * (v7). Empty is empty: a column with a DEFAULT is still filled by PostgreSQL, which also checks what is written.
 * A ULID has its own field (WidgetUlidInput.vue).
 */
import { uuidV4, uuidV7 } from '~/utils/random-uuid'

const modelValue = defineModel<string | null | undefined>()
withDefaults(defineProps<{
  format?: 'v4' | 'v7'
  disabled?: boolean
}>(), {
  format: 'v4',
  disabled: false
})

const { t } = useI18n()
</script>

<template>
  <UInput
    :model-value="modelValue ?? ''"
    :disabled="disabled"
    @update:model-value="(value: string | number) => { modelValue = String(value).trim() || null }"
  >
    <template
      v-if="!disabled"
      #trailing
    >
      <UButton
        color="neutral"
        variant="link"
        size="sm"
        icon="i-lucide-refresh-cw"
        :aria-label="t('dataviews.widgetUuid.generate')"
        @click="modelValue = format === 'v7' ? uuidV7() : uuidV4()"
      />
    </template>
  </UInput>
</template>
