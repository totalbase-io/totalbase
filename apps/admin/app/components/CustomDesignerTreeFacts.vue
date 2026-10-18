<script setup lang="ts">
/** What a widget carries, on its Structure row (CustomDesignerTree.vue): hidden, formulas, events, a refused configuration. */
import type { TreeFacts } from '~/composables/useCustomDesignerTree'

defineProps<{ facts: TreeFacts }>()
const { t } = useI18n()
</script>

<template>
  <UTooltip
    v-if="facts.hidden !== null"
    :text="facts.hidden === false ? t('designer.customDesignerTree.hiddenOff') : t('designer.customDesignerTree.hiddenFormula', { formula: facts.hidden })"
  >
    <UIcon
      name="i-lucide-eye-off"
      class="size-3.5"
      :aria-label="t('designer.customDesignerTree.filter.hidden')"
    />
  </UTooltip>
  <UTooltip
    v-if="facts.formulas.length"
    :text="t('designer.customDesignerTree.formulas', { props: facts.formulas.join(', ') })"
  >
    <UIcon
      name="i-lucide-square-function"
      class="size-3.5"
      :aria-label="t('designer.customDesignerTree.filter.formula')"
    />
  </UTooltip>
  <UTooltip
    v-if="facts.events.length"
    :text="t('designer.customDesignerTree.events', { events: facts.events.join(', ') })"
  >
    <UIcon
      name="i-lucide-zap"
      class="size-3.5"
      :aria-label="t('designer.customDesignerTree.eventsLabel')"
    />
  </UTooltip>
  <UTooltip
    v-if="facts.errors.length"
    :text="facts.errors.join(' ')"
  >
    <span
      class="size-2 rounded-full bg-error"
      :aria-label="t('designer.customDesignerTree.filter.error')"
    />
  </UTooltip>
</template>
