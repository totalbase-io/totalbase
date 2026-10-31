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
const SIZE_OPTIONS = computed(() => [
  { value: 'xs', label: 'XS', tooltip: t('designer.inspector.style.sizeXs') },
  { value: 's', label: 'S', tooltip: t('designer.inspector.style.sizeS') },
  { value: 'm', label: 'M', tooltip: t('designer.inspector.style.sizeM') },
  { value: 'l', label: 'L', tooltip: t('designer.inspector.style.sizeL') },
  { value: 'xl', label: 'XL', tooltip: t('designer.inspector.style.sizeXl') },
  { value: '2xl', label: '2XL', tooltip: t('designer.inspector.style.size2xl') },
  { value: '3xl', label: '3XL', tooltip: t('designer.inspector.style.size3xl') }
])
const WEIGHT_OPTIONS = computed(() => [
  { value: 'normal', label: t('designer.inspector.style.normal'), tooltip: t('designer.inspector.style.normal') },
  { value: 'medium', label: t('designer.inspector.style.medium'), tooltip: t('designer.inspector.style.medium') },
  { value: 'semibold', label: t('designer.inspector.style.semibold'), tooltip: t('designer.inspector.style.semibold') },
  { value: 'bold', label: t('designer.inspector.style.bold'), tooltip: t('designer.inspector.style.bold') }
])
// Italic, underline and strike-through as one group of equal buttons - two props (fontStyle, textDecoration), each toggling its own.
const TEXT_STYLE_OPTIONS = computed(() => [
  { prop: 'fontStyle', value: 'italic', icon: 'i-lucide-italic', tooltip: t('designer.inspector.style.italic') },
  { prop: 'textDecoration', value: 'underline', icon: 'i-lucide-underline', tooltip: t('designer.inspector.style.underline') },
  { prop: 'textDecoration', value: 'lineThrough', icon: 'i-lucide-strikethrough', tooltip: t('designer.inspector.style.lineThrough') }
])
// The text colors as fills of the same tokens, so a swatch is the color the text takes.
const TEXT_COLOR_OPTIONS = computed(() => [
  { value: 'muted', label: t('designer.inspector.style.muted'), swatch: 'bg-(--ui-text-muted)' },
  { value: 'dimmed', label: t('designer.inspector.style.dimmed'), swatch: 'bg-(--ui-text-dimmed)' },
  { value: 'toned', label: t('designer.inspector.style.toned'), swatch: 'bg-(--ui-text-toned)' },
  { value: 'highlighted', label: t('designer.inspector.style.highlighted'), swatch: 'bg-(--ui-text-highlighted)' },
  { value: 'primary', label: t('designer.inspector.style.primary'), swatch: 'bg-primary' },
  { value: 'secondary', label: t('designer.inspector.style.secondary'), swatch: 'bg-secondary' },
  { value: 'success', label: t('designer.inspector.style.success'), swatch: 'bg-success' },
  { value: 'info', label: t('designer.inspector.style.info'), swatch: 'bg-info' },
  { value: 'warning', label: t('designer.inspector.style.warning'), swatch: 'bg-warning' },
  { value: 'error', label: t('designer.inspector.style.error'), swatch: 'bg-error' }
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
    <USeparator :label="t('designer.inspector.style.text')" />
    <UFormField :label="t('designer.inspector.style.size')">
      <StyleSegmented
        :model-value="str('fontSize')"
        none
        :options="SIZE_OPTIONS"
        @update:model-value="emit('set', 'fontSize', $event)"
      />
    </UFormField>
    <UFormField :label="t('designer.inspector.style.weight')">
      <StyleSegmented
        :model-value="str('fontWeight')"
        none
        :options="WEIGHT_OPTIONS"
        @update:model-value="emit('set', 'fontWeight', $event)"
      />
    </UFormField>
    <UFormField :label="t('designer.inspector.style.textStyle')">
      <UFieldGroup class="w-full max-w-80">
        <UTooltip
          v-for="option in TEXT_STYLE_OPTIONS"
          :key="option.value"
          :text="option.tooltip"
        >
          <UButton
            :icon="option.icon"
            size="xs"
            :color="str(option.prop) === option.value ? 'primary' : 'neutral'"
            :variant="str(option.prop) === option.value ? 'solid' : 'outline'"
            class="flex-1 justify-center"
            :aria-label="option.tooltip"
            :aria-pressed="str(option.prop) === option.value"
            @click="emit('set', option.prop, str(option.prop) === option.value ? undefined : option.value)"
          />
        </UTooltip>
      </UFieldGroup>
    </UFormField>
    <UFormField :label="t('designer.inspector.style.textColor')">
      <StyleSwatches
        :model-value="str('textColor')"
        :options="TEXT_COLOR_OPTIONS"
        @update:model-value="emit('set', 'textColor', $event)"
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
