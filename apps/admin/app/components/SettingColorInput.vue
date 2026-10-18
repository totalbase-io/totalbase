<script setup lang="ts">
/**
 * `appearance.primary_color` (Specification_Admin_UI.md §4.1.1): a hex, or
 * empty for the product's blue. The browser's own color picker behind a
 * swatch, the hex typed beside it, and a few presets - one color is all
 * the server needs, it derives the shades.
 */
import { HEX_COLOR } from '@totalbase/shared'

const modelValue = defineModel<string>({ required: true })
defineProps<{ label: string }>()
const { t } = useI18n()

const PRESETS = ['#2563eb', '#0f766e', '#059669', '#7c3aed', '#db2777', '#ea580c', '#475569']
const DEFAULT_SWATCH = '#2563eb'

const typed = ref(modelValue.value)
watch(modelValue, (value) => {
  typed.value = value
})
/** A typed value reaches the setting once it is a color (or empty); the field keeps what was typed meanwhile. */
function commitTyped() {
  const value = typed.value.trim().toLowerCase()
  if (value === '' || HEX_COLOR.test(value)) modelValue.value = value
  else typed.value = modelValue.value
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <label
      class="relative inline-flex size-8 shrink-0 cursor-pointer overflow-hidden rounded-md border border-default"
      :style="{ backgroundColor: modelValue || DEFAULT_SWATCH }"
      :aria-label="label"
    >
      <input
        type="color"
        :value="modelValue || DEFAULT_SWATCH"
        class="absolute inset-0 size-full cursor-pointer opacity-0"
        @input="modelValue = ($event.target as HTMLInputElement).value"
      >
    </label>
    <UInput
      v-model="typed"
      :aria-label="`${label} (hex)`"
      class="w-32 font-mono"
      @blur="commitTyped"
      @keydown.enter.prevent="commitTyped"
    />
    <div class="flex items-center gap-1">
      <button
        v-for="preset in PRESETS"
        :key="preset"
        type="button"
        :title="preset"
        :aria-label="preset"
        class="size-6 rounded-full border border-default"
        :class="{ 'ring-2 ring-offset-1 ring-primary': modelValue === preset }"
        :style="{ backgroundColor: preset }"
        @click="modelValue = preset"
      />
    </div>
    <UButton
      v-if="modelValue"
      :label="t('settings.appearance.defaultColor')"
      color="neutral"
      variant="ghost"
      @click="modelValue = ''"
    />
  </div>
</template>
