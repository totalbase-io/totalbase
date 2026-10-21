<script setup lang="ts">
/**
 * The PROGRESS dashboard widget's body (Dashboards.md §5.15, D12): Nuxt UI's UProgress and its line -
 * "$ 13.9M of $ 30M · 46 %". Its color - a threshold's or its Color, a palette shade from its builder - is the bar's
 * own (`--ui-primary` on it alone); past its target the bar is full and the percent real. A text line and the bar
 * fit a card of one grid row (3x1, DB12). Purely presentational: its card handles the click.
 */
import type { ProgressModel } from '~/utils/dashboard-builders'

const props = defineProps<{ model: ProgressModel }>()

/** The whole line, read out and on hover. */
const line = computed(() => [props.model.value, props.model.target, props.model.percent].filter(Boolean).join(' · '))
</script>

<template>
  <div class="progress-widget h-full min-h-0">
    <div class="progress-body flex h-full flex-col justify-center gap-1.5">
      <p
        class="flex min-w-0 items-baseline gap-1.5"
        :title="line"
      >
        <span
          class="min-w-0 truncate text-[clamp(0.875rem,8cqw,1.5rem)] font-semibold tabular-nums text-highlighted"
          :style="model.color ? { color: model.color } : undefined"
        >{{ model.value }}</span>
        <span
          v-if="model.target"
          class="min-w-0 truncate text-xs text-muted"
        >{{ model.target }}</span>
        <span
          v-if="model.percent"
          class="shrink-0 text-sm font-medium tabular-nums text-default"
        ><span
          v-if="model.target"
          aria-hidden="true"
          class="text-muted"
        >· </span>{{ model.percent }}</span>
      </p>
      <div
        class="progress-bar"
        :style="model.color ? { '--ui-primary': model.color } : undefined"
      >
        <UProgress
          :model-value="model.bar"
          :max="100"
          :aria-label="line"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Sized by its card both ways: the value's text follows the width (cqw); a card too low for text over bar (3x1, DB12)
   puts them side by side, the bar taking what the text leaves. */
.progress-widget {
  container-type: size;
}
@container (max-height: 3.25rem) {
  .progress-body {
    flex-direction: row;
    align-items: center;
    gap: 0.75rem;
  }
  .progress-body > p {
    flex: 0 1 auto;
  }
  .progress-bar {
    flex: 1 1 3rem;
    min-width: 3rem;
  }
}
</style>
