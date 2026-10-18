<script setup lang="ts">
/**
 * THeading (WIDGET_CATALOG) - a section title. TotalBase's own widget: Nuxt
 * UI has no heading component. Same sizes the DataView form's HEADING
 * control uses (WidgetRenderer.vue).
 */
export type HeadingLevel = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'

const props = withDefaults(defineProps<{
  label?: string
  level?: HeadingLevel
}>(), {
  label: '',
  level: 'h2'
})

// Literal classes, for Tailwind's scanner.
const LEVEL_CLASSES: Record<HeadingLevel, string> = {
  h1: 'text-3xl font-bold text-highlighted',
  h2: 'text-2xl font-bold text-highlighted',
  h3: 'text-xl font-semibold text-highlighted',
  h4: 'text-lg font-semibold text-highlighted',
  h5: 'text-base font-semibold text-highlighted',
  h6: 'text-sm font-semibold text-highlighted'
}
</script>

<template>
  <component
    :is="props.level"
    :class="LEVEL_CLASSES[props.level]"
  >
    {{ props.label }}
  </component>
</template>
