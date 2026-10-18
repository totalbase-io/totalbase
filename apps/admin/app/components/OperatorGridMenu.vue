<script setup lang="ts" generic="T extends string">
// Popover + grid of buttons for picking one operator, full symbol and
// text both shown (chosen over a plain dropdown list and over a
// compact icon-only grid) - same trigger-button-plus-
// popover-grid shape as ColorPickerField.vue/IconPickerField.vue, just
// with text cells instead of color dots/icons since an operator needs
// its label to stay legible ("≥ greater or equal", not just "≥").
export interface OperatorGridItem<V extends string> {
  value: V
  label: string
}

const modelValue = defineModel<T | undefined>()
const props = defineProps<{
  items: OperatorGridItem<T>[]
}>()

const { t } = useI18n()
const open = ref(false)
const selectedLabel = computed(() => props.items.find(item => item.value === modelValue.value)?.label)

function select(value: T) {
  modelValue.value = value
  open.value = false
}
</script>

<template>
  <UPopover v-model:open="open">
    <UButton
      :label="selectedLabel ?? t('database.operatorGridMenu.selectOperator')"
      color="neutral"
      variant="outline"
      trailing-icon="i-lucide-chevron-down"
      class="w-full justify-between"
    />
    <template #content>
      <div class="grid grid-cols-2 gap-1 p-2 w-80">
        <UButton
          v-for="item in items"
          :key="item.value"
          :label="item.label"
          :color="modelValue === item.value ? 'primary' : 'neutral'"
          :variant="modelValue === item.value ? 'soft' : 'ghost'"
          size="xs"
          class="justify-start"
          @click="select(item.value)"
        />
      </div>
    </template>
  </UPopover>
</template>
