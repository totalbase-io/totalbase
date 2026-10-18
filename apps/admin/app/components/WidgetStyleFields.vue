<script setup lang="ts">
/**
 * Styles - the common style block of a widget (@totalbase/tb-catalog COMMON_STYLE_PROPS), as design tools lay it out:
 * spacing as a box model, alignment as icons, colors as swatches. A page widget's inspector and a dashboard
 * widget's show the same one; each keeps the values where its own config does.
 */
const props = defineProps<{
  /** The style values as set (unset absent). */
  values: Record<string, unknown>
  /** How many are set - "N styles applied" and Reset, when any. */
  applied: number
  /** Leave out "In its row" - a widget alone in its cell (a dashboard's) has no row to align in. */
  noRowAlign?: boolean
}>()
const emit = defineEmits<{ set: [name: string, value: unknown], reset: [] }>()
const { t } = useI18n()
const str = (name: string) => (typeof props.values[name] === 'string' ? props.values[name] as string : undefined)

// Style's controls: each value COMMON_STYLE_PROPS offers, shown the familiar way.
const ALIGN_OPTIONS = computed(() => [
  { value: 'start', icon: 'i-lucide-align-left', tooltip: t('designer.inspector.style.left') },
  { value: 'center', icon: 'i-lucide-align-center', tooltip: t('designer.inspector.style.center') },
  { value: 'end', icon: 'i-lucide-align-right', tooltip: t('designer.inspector.style.right') }
])
const VERTICAL_ALIGN_OPTIONS = computed(() => [
  { value: 'top', icon: 'i-lucide-align-vertical-justify-start', tooltip: t('designer.inspector.style.top') },
  { value: 'center', icon: 'i-lucide-align-vertical-justify-center', tooltip: t('designer.inspector.style.middle') },
  { value: 'bottom', icon: 'i-lucide-align-vertical-justify-end', tooltip: t('designer.inspector.style.bottom') },
  { value: 'stretch', icon: 'i-lucide-stretch-vertical', tooltip: t('designer.inspector.style.stretch') }
])
const RADIUS_OPTIONS = computed(() => [
  { value: 's', label: 'S', tooltip: t('designer.inspector.style.slightlyRounded') },
  { value: 'm', label: 'M', tooltip: t('designer.inspector.style.rounded') },
  { value: 'l', label: 'L', tooltip: t('designer.inspector.style.veryRounded') },
  { value: 'full', label: t('designer.inspector.style.full'), tooltip: t('designer.inspector.style.pill') }
])
const SHADOW_OPTIONS = computed(() => [
  { value: 's', label: 'S', tooltip: t('designer.inspector.style.smallShadow') },
  { value: 'm', label: 'M', tooltip: t('designer.inspector.style.mediumShadow') },
  { value: 'l', label: 'L', tooltip: t('designer.inspector.style.largeShadow') }
])
const BACKGROUND_OPTIONS = computed(() => [
  { value: 'muted', label: t('designer.inspector.style.muted'), swatch: 'bg-muted border border-default' },
  { value: 'elevated', label: t('designer.inspector.style.elevated'), swatch: 'bg-elevated border border-default' },
  { value: 'accented', label: t('designer.inspector.style.accented'), swatch: 'bg-accented border border-default' },
  { value: 'primary', label: t('designer.inspector.style.primarySoft'), swatch: 'bg-primary/10 border border-primary/25' }
])
const BORDER_OPTIONS = computed(() => [
  { value: 'muted', label: t('designer.inspector.style.muted'), swatch: 'border-2 border-default' },
  { value: 'accented', label: t('designer.inspector.style.accented'), swatch: 'border-2 border-accented' },
  { value: 'primary', label: t('designer.inspector.style.primary'), swatch: 'border-2 border-primary' }
])
</script>

<template>
  <div class="flex flex-col gap-3">
    <!-- With any style set: back to the widget's own look, all at once. -->
    <div
      v-if="applied"
      class="flex items-center justify-between gap-2"
    >
      <span class="text-xs text-muted">{{ t('designer.inspector.stylesApplied', applied) }}</span>
      <UButton
        :label="t('common.reset')"
        icon="i-lucide-rotate-ccw"
        size="xs"
        color="neutral"
        variant="outline"
        @click="emit('reset')"
      />
    </div>
    <USeparator :label="t('designer.inspector.style.spacing')" />
    <StyleBoxModel
      :values="values"
      @set="(name: string, value: unknown) => emit('set', name, value)"
    />
    <USeparator :label="t('designer.inspector.style.alignment')" />
    <UFormField :label="t('designer.inspector.style.content')">
      <StyleSegmented
        :model-value="str('align')"
        :options="ALIGN_OPTIONS"
        @update:model-value="emit('set', 'align', $event)"
      />
    </UFormField>
    <UFormField
      v-if="!noRowAlign"
      :label="t('designer.inspector.style.inItsRow')"
    >
      <StyleSegmented
        :model-value="str('verticalAlign')"
        :options="VERTICAL_ALIGN_OPTIONS"
        @update:model-value="emit('set', 'verticalAlign', $event)"
      />
    </UFormField>
    <USeparator :label="t('designer.inspector.style.appearance')" />
    <UFormField :label="t('designer.inspector.style.background')">
      <StyleSwatches
        :model-value="str('background')"
        :options="BACKGROUND_OPTIONS"
        @update:model-value="emit('set', 'background', $event)"
      />
    </UFormField>
    <UFormField :label="t('designer.inspector.style.border')">
      <StyleSwatches
        :model-value="str('border')"
        :options="BORDER_OPTIONS"
        @update:model-value="emit('set', 'border', $event)"
      />
    </UFormField>
    <UFormField :label="t('designer.inspector.style.radius')">
      <StyleSegmented
        :model-value="str('radius')"
        none
        :options="RADIUS_OPTIONS"
        @update:model-value="emit('set', 'radius', $event)"
      />
    </UFormField>
    <UFormField :label="t('designer.inspector.style.shadow')">
      <StyleSegmented
        :model-value="str('shadow')"
        none
        :options="SHADOW_OPTIONS"
        @update:model-value="emit('set', 'shadow', $event)"
      />
    </UFormField>
  </div>
</template>
