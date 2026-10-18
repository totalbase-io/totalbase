<script setup lang="ts">
/**
 * `JsonEditor.vue` (the same Monaco editor WhereField's own Builder
 * popover already uses) adapter for a `json`/`jsonb` COLUMN field -
 * its own `modelValue` is a plain string, never the raw parsed object/
 * array the column's real value actually is (the API hands back real
 * JSON, not text). Binding that raw value straight into ANY text
 * widget's v-model, unconverted, is exactly the "[object Object]" bug
 * this exists to fix - converts on the way in
 * (JSON.stringify, pretty) and back out (JSON.parse) so
 * WidgetRenderer.vue can still bind `v-model` to the raw
 * column value like every other widget - this is the one seam.
 * Rendered only when `config.isJsonColumn` is set (field-config.ts's
 * own doc comment on why that's a persisted flag, not inferred from
 * the widget or the live value) - `WidgetRenderer.vue`'s own
 * `isJsonTextareaFor`.
 */
const modelValue = defineModel<unknown>()
withDefaults(defineProps<{
  disabled?: boolean
  minHeight?: string
}>(), {
  disabled: false
})

const { t } = useI18n()
const invalid = ref(false)
/**
 * What the editor actually shows - re-derived from `modelValue`
 * whenever it changes from OUTSIDE this component (a fresh row
 * seeded, another field's save triggering a reload). Typing itself
 * never fights this watch: `modelValue` only changes below, in
 * `onUpdate`, from the SAME string this watch would just re-derive
 * right back into - JsonEditor's own modelValue watch already no-ops
 * a redundant `setValue` for exactly that reason.
 */
const text = ref('')

watch(() => modelValue.value, (value) => {
  invalid.value = false
  text.value = value === null || value === undefined ? '' : JSON.stringify(value, null, 2)
}, { immediate: true })

// No blur handshake needed (JsonEditor has no blur event of its own) -
// every keystroke tries to parse; a successful parse commits straight
// to `modelValue`, an invalid one just flags it and leaves `modelValue`
// at its last good value - never corrupted, never silently discarded.
function onUpdate(next: string) {
  text.value = next
  const trimmed = next.trim()
  if (!trimmed) {
    invalid.value = false
    modelValue.value = null
    return
  }
  try {
    modelValue.value = JSON.parse(trimmed)
    invalid.value = false
  } catch {
    invalid.value = true
  }
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <JsonEditor
      :model-value="text"
      :min-height="minHeight ?? '8rem'"
      :disabled="disabled"
      @update:model-value="onUpdate"
    />
    <p
      v-if="invalid"
      class="text-xs text-error"
    >
      {{ t('designer.widgetJsonEditor.invalid') }}
    </p>
  </div>
</template>
