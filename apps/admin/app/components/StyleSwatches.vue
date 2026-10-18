<script setup lang="ts">
/**
 * A Style color - a background or a border - as swatches of the theme's own
 * tokens, the way design tools show fills: each drawn as it will look, its
 * name in a tooltip; the chosen one ringed. None (struck through) unsets
 * it, as does clicking the chosen one again.
 */
defineProps<{
  options: readonly { value: string, label: string, swatch: string }[]
}>()
const model = defineModel<string | undefined>({ required: true })
const { t } = useI18n()
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <!-- None: the struck-through swatch design tools use for "no fill" - chosen while nothing is set. -->
    <UTooltip :text="t('common.none')">
      <button
        type="button"
        class="relative size-7 overflow-hidden rounded-md border border-default ring-offset-1 ring-offset-(--ui-bg) transition"
        :class="model === undefined ? 'ring-2 ring-primary' : 'hover:ring-1 hover:ring-accented'"
        :aria-label="t('common.none')"
        :aria-pressed="model === undefined"
        @click="model = undefined"
      >
        <span class="absolute left-1/2 top-1/2 h-px w-8 -translate-x-1/2 -translate-y-1/2 -rotate-45 bg-error/60" />
      </button>
    </UTooltip>
    <UTooltip
      v-for="option in options"
      :key="option.value"
      :text="option.label"
    >
      <!-- A color swatch: a native button (AGENTS.md section 25). -->
      <button
        type="button"
        class="size-7 rounded-md ring-offset-1 ring-offset-(--ui-bg) transition"
        :class="[option.swatch, model === option.value ? 'ring-2 ring-primary' : 'hover:ring-1 hover:ring-accented']"
        :aria-label="option.label"
        :aria-pressed="model === option.value"
        @click="model = model === option.value ? undefined : option.value"
      />
    </UTooltip>
  </div>
</template>
