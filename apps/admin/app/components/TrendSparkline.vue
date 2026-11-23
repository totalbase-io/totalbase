<script setup lang="ts">
/**
 * A trend at a glance - one line over a series of counts, no axes, no
 * numbers: it sits under a figure that already says how much (Status'
 * headline counts). Decorative: the figure beside it carries the meaning.
 */
const props = defineProps<{ values: number[] }>()

const WIDTH = 100
const HEIGHT = 24
const points = computed(() => {
  const max = Math.max(...props.values, 1)
  const step = props.values.length > 1 ? WIDTH / (props.values.length - 1) : 0
  // One unit of room above and below, so the stroke isn't clipped at either end of the scale.
  return props.values.map((value, i) => `${(i * step).toFixed(2)},${(HEIGHT - 1 - (value / max) * (HEIGHT - 2)).toFixed(2)}`).join(' ')
})
</script>

<template>
  <svg
    :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
    preserveAspectRatio="none"
    class="h-6 w-full text-primary"
    aria-hidden="true"
  >
    <polyline
      :points="points"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linejoin="round"
      stroke-linecap="round"
      vector-effect="non-scaling-stroke"
    />
  </svg>
</template>
