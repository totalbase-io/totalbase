<script setup lang="ts">
/**
 * The password field (TPasswordInput, DataViews.md §16.1): a Password column's control, with an eye that shows what
 * was typed. Never a stored value - the column holds a hash and is never read (Security.md §2.3), so on an edit the
 * field starts empty and stays out of the save unless something is typed. Emptied, it is no value (null), never ""
 * - which the server would check as a too-short password.
 */
const modelValue = defineModel<string | null | undefined>()
withDefaults(defineProps<{
  revealable?: boolean
  disabled?: boolean
}>(), {
  revealable: true,
  disabled: false
})

const { t } = useI18n()
const shown = ref(false)
</script>

<template>
  <UInput
    :model-value="modelValue ?? ''"
    :type="shown ? 'text' : 'password'"
    autocomplete="new-password"
    :disabled="disabled"
    @update:model-value="(value: string | number) => { modelValue = String(value) || null }"
  >
    <template
      v-if="revealable && !disabled"
      #trailing
    >
      <UButton
        color="neutral"
        variant="link"
        size="sm"
        :icon="shown ? 'i-lucide-eye-off' : 'i-lucide-eye'"
        :aria-label="shown ? t('dataviews.widgetPassword.hide') : t('dataviews.widgetPassword.show')"
        :aria-pressed="shown"
        @click="shown = !shown"
      />
    </template>
  </UInput>
</template>
