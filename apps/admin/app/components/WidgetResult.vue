<script setup lang="ts">
/**
 * The Result widget (TResult, Specification_DataViews.md §9.11): a large
 * panel with an outcome at a glance - a color, an icon, a title and a
 * description - shown by the page's Code (`dataview.controls.<name>.show()`),
 * with a tone and a vibration, back to its waiting state on its own after
 * `resetAfter` seconds. A kiosk's answer to a scan. The logic lives in
 * utils/result-panel.ts.
 */
import { createResultTimer, resolveResult, resultSeconds, RESULT_TONES, RESULT_VIBRATIONS, toneOf, type ResultColor, type ResultShowOptions, type ResultState } from '~/utils/result-panel'
import { playTones, vibrate as vibrateDevice } from '~/utils/device-feedback'

type Variant = 'solid' | 'outline' | 'soft' | 'subtle'

const props = withDefaults(defineProps<{
  idleTitle?: string
  idleDescription?: string
  idleIcon?: string
  idleColor?: ResultColor
  resetAfter?: number
  variant?: Variant
  size?: 'md' | 'lg' | 'xl'
  sound?: boolean
  vibrate?: boolean
}>(), {
  idleTitle: undefined,
  idleDescription: undefined,
  idleIcon: undefined,
  idleColor: 'neutral',
  resetAfter: 5,
  variant: 'solid',
  size: 'lg',
  sound: true,
  vibrate: true
})
const emit = defineEmits<{ reset: [] }>()

const { t } = useI18n()
const result = ref<ResultState | null>(null)
const timer = createResultTimer(() => reset())
onBeforeUnmount(() => timer.cancel())

/** `dataview.controls.<name>.show({ color, icon, title, description, sound, resetAfter })` - a text alone is its title. */
function show(options?: ResultShowOptions | string) {
  const next = resolveResult(options, { sound: props.sound !== false, resetAfter: resultSeconds(props.resetAfter, 5) })
  result.value = next
  if (next.tone) playTones(RESULT_TONES[next.tone])
  if (props.vibrate !== false) vibrateDevice(RESULT_VIBRATIONS[next.tone ?? toneOf(next.color)])
  timer.start(next.resetAfter)
}

/** `dataview.controls.<name>.reset()` - back to waiting now. */
function reset() {
  timer.cancel()
  if (result.value === null) return
  result.value = null
  emit('reset')
}

defineExpose({ show, reset })

const shown = computed(() => result.value ?? {
  color: props.idleColor ?? 'neutral',
  icon: props.idleIcon || 'i-lucide-scan-line',
  title: props.idleTitle ?? t('dataviews.widgetResult.ready'),
  description: props.idleDescription ?? ''
})

// Nuxt UI's colors, spelled out so Tailwind sees every class.
const SOLID: Record<ResultColor, string> = {
  primary: 'bg-primary text-inverted',
  secondary: 'bg-secondary text-inverted',
  success: 'bg-success text-inverted',
  info: 'bg-info text-inverted',
  warning: 'bg-warning text-inverted',
  error: 'bg-error text-inverted',
  neutral: 'bg-inverted text-inverted'
}
const OUTLINE: Record<ResultColor, string> = {
  primary: 'text-primary ring ring-inset ring-primary/50',
  secondary: 'text-secondary ring ring-inset ring-secondary/50',
  success: 'text-success ring ring-inset ring-success/50',
  info: 'text-info ring ring-inset ring-info/50',
  warning: 'text-warning ring ring-inset ring-warning/50',
  error: 'text-error ring ring-inset ring-error/50',
  neutral: 'text-highlighted ring ring-inset ring-accented'
}
const SOFT: Record<ResultColor, string> = {
  primary: 'bg-primary/10 text-primary',
  secondary: 'bg-secondary/10 text-secondary',
  success: 'bg-success/10 text-success',
  info: 'bg-info/10 text-info',
  warning: 'bg-warning/10 text-warning',
  error: 'bg-error/10 text-error',
  neutral: 'bg-elevated/50 text-highlighted'
}
const SUBTLE: Record<ResultColor, string> = {
  primary: 'bg-primary/10 text-primary ring ring-inset ring-primary/25',
  secondary: 'bg-secondary/10 text-secondary ring ring-inset ring-secondary/25',
  success: 'bg-success/10 text-success ring ring-inset ring-success/25',
  info: 'bg-info/10 text-info ring ring-inset ring-info/25',
  warning: 'bg-warning/10 text-warning ring ring-inset ring-warning/25',
  error: 'bg-error/10 text-error ring ring-inset ring-error/25',
  neutral: 'bg-elevated/50 text-highlighted ring ring-inset ring-accented'
}
const VARIANTS: Record<Variant, Record<ResultColor, string>> = { solid: SOLID, outline: OUTLINE, soft: SOFT, subtle: SUBTLE }
/** Waiting, it is always soft - a result stands out from it. */
const colorClass = computed(() => (result.value ? VARIANTS[props.variant] ?? SOLID : SOFT)[shown.value.color] ?? SOFT.neutral)

const SIZES = {
  md: { icon: 'size-12', title: 'text-2xl', description: 'text-base', box: 'min-h-48 gap-2 p-6' },
  lg: { icon: 'size-20', title: 'text-4xl', description: 'text-xl', box: 'min-h-64 gap-3 p-8' },
  xl: { icon: 'size-28', title: 'text-6xl', description: 'text-3xl', box: 'min-h-80 gap-4 p-10' }
} as const
const sizeClass = computed(() => SIZES[props.size] ?? SIZES.lg)
</script>

<template>
  <div
    role="status"
    aria-live="assertive"
    aria-atomic="true"
    :data-result="result ? result.color : 'idle'"
    class="flex h-full w-full flex-col items-center justify-center rounded-lg text-center transition-colors duration-200"
    :class="[colorClass, sizeClass.box]"
  >
    <UIcon
      v-if="shown.icon"
      :name="shown.icon"
      class="shrink-0"
      :class="sizeClass.icon"
    />
    <p
      v-if="shown.title"
      class="max-w-full font-semibold leading-tight text-balance [overflow-wrap:anywhere]"
      :class="sizeClass.title"
    >
      {{ shown.title }}
    </p>
    <p
      v-if="shown.description"
      class="max-w-full whitespace-pre-line text-balance opacity-90 [overflow-wrap:anywhere]"
      :class="sizeClass.description"
    >
      {{ shown.description }}
    </p>
  </div>
</template>
