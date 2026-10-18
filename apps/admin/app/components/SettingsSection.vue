<script setup lang="ts">
/**
 * A titled section of a settings page or a detail page: the uppercase
 * heading over a rule, an optional description under it, the content
 * below - one shape for every page (AGENTS.md §25), not a class string
 * copied per section. `#actions` puts a control (a button, a badge) at
 * the heading row's right end.
 */
withDefaults(defineProps<{
  title: string
  description?: string
  /** The heading's level - a page's sections are h4 under its h1. */
  tag?: 'h2' | 'h3' | 'h4'
}>(), { description: undefined, tag: 'h4' })
</script>

<template>
  <section class="flex flex-col gap-4">
    <div class="flex items-center justify-between gap-3 border-b border-default pb-2">
      <div class="min-w-0">
        <component
          :is="tag"
          class="text-sm font-semibold uppercase tracking-wide text-highlighted"
        >
          {{ title }}
        </component>
        <p
          v-if="description"
          class="text-xs text-muted"
        >
          {{ description }}
        </p>
      </div>
      <div
        v-if="$slots.actions"
        class="flex shrink-0 items-center gap-2"
      >
        <slot name="actions" />
      </div>
    </div>
    <slot />
  </section>
</template>
