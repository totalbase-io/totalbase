<script setup lang="ts">
/**
 * A Style option as a row of buttons - text or an icon each, the chosen one
 * in primary, as design tools show alignment, radius or shadow. Clicking the
 * chosen one again unsets it (the widget's default).
 */
const props = defineProps<{
  options: readonly { value: string, label?: string, icon?: string, tooltip: string }[]
  /** A first "None" button, chosen while nothing is set - for what has no natural default (radius, shadow). */
  none?: boolean
}>()
const model = defineModel<string | undefined>({ required: true })

const { t } = useI18n()
function toggle(value: string) {
  model.value = model.value === value ? undefined : value
}
const options = computed(() => props.options)
</script>

<template>
  <UFieldGroup class="w-full max-w-80">
    <UButton
      v-if="none"
      :label="t('common.none')"
      size="xs"
      :color="model === undefined ? 'primary' : 'neutral'"
      :variant="model === undefined ? 'solid' : 'outline'"
      class="flex-1 justify-center"
      :aria-pressed="model === undefined"
      @click="model = undefined"
    />
    <UTooltip
      v-for="option in options"
      :key="option.value"
      :text="option.tooltip"
    >
      <UButton
        :label="option.label"
        :icon="option.icon"
        size="xs"
        :color="model === option.value ? 'primary' : 'neutral'"
        :variant="model === option.value ? 'solid' : 'outline'"
        class="flex-1 justify-center"
        :aria-label="option.tooltip"
        :aria-pressed="model === option.value"
        @click="toggle(option.value)"
      />
    </UTooltip>
  </UFieldGroup>
</template>
