<script setup lang="ts">
/**
 * The ULID field (TUlidInput, DataViews.md §16.1): a text field of 26 characters a ULID is typed or pasted into,
 * with an icon inside it - where a password field has its eye - that generates a new one (its time first, so it
 * sorts by when it was made). Empty is empty; PostgreSQL checks what is written.
 */
import { ulid } from '~/utils/random-uuid'

const modelValue = defineModel<string | null | undefined>()
withDefaults(defineProps<{
  disabled?: boolean
}>(), {
  disabled: false
})

const { t } = useI18n()
</script>

<template>
  <UInput
    :model-value="modelValue ?? ''"
    :disabled="disabled"
    :maxlength="26"
    @update:model-value="(value: string | number) => { modelValue = String(value).trim().toUpperCase() || null }"
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
        @click="modelValue = ulid()"
      />
    </template>
  </UInput>
</template>
