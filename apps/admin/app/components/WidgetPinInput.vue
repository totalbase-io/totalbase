<script setup lang="ts">
/**
 * `UPinInput` adapter for a plain string COLUMN field - Nuxt UI's own
 * `modelValue` is an array, one entry per box (`string[]`, or
 * `number[]` with `type="number"` - never used here), not the single
 * joined string the column actually stores. Converts on the way in
 * (`split('')`) and back out (`join('')`) so `WidgetRenderer.
 * vue` can still bind straight to the raw column value.
 */
const modelValue = defineModel<string | null | undefined>()
const props = defineProps<{ disabled?: boolean, length?: number }>()

const chars = computed<string[]>({
  get() {
    return (modelValue.value ?? '').split('').slice(0, props.length ?? 5)
  },
  set(value) {
    const joined = value.join('')
    modelValue.value = joined || null
  }
})
</script>

<template>
  <UPinInput
    v-model="chars"
    :length="length ?? 5"
    :disabled="disabled"
  />
</template>
