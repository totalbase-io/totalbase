<script setup lang="ts">
/**
 * The Location widget (TGeolocation, Specification_DataViews.md §9.9): the
 * device's position into a `point` column, no map - a button, the
 * coordinates once captured, and why not when there's none. `auto` captures
 * when the field opens empty (a reading's "where it was taken"); the button
 * takes it again. Same `{ lng, lat }` as the map field; the accuracy goes
 * out in `located` only, never into the value.
 */
import { currentLocation, locationProblem, type DeviceLocation, type LocationProblem } from '~/utils/device-location'

export interface LocationPoint { lng: number, lat: number }

const modelValue = defineModel<LocationPoint | null | undefined>()
const props = withDefaults(defineProps<{
  /** Captures the position when the field opens with no value. */
  auto?: boolean
  /** The coordinates beside the button once there's a value. */
  showCoordinates?: boolean
  /** GPS over the network's guess - slower, exact. */
  highAccuracy?: boolean
  /** The button's label - unset: Mark position. */
  label?: string
  icon?: string
  color?: 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'error' | 'neutral'
  variant?: 'solid' | 'outline' | 'soft' | 'subtle' | 'ghost' | 'link'
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  disabled?: boolean
}>(), {
  auto: true,
  showCoordinates: true,
  highAccuracy: true,
  label: undefined,
  icon: undefined,
  color: undefined,
  variant: undefined,
  size: undefined,
  disabled: false
})
const emit = defineEmits<{
  located: [location: DeviceLocation]
  locateFailed: [error: { reason: LocationProblem, message: string }]
}>()

const { t } = useI18n()
const locating = ref(false)
const problem = ref<LocationProblem | null>(null)

/** The device's position into the value; a failure keeps what was there and says why. */
async function locate() {
  if (props.disabled || locating.value) return
  locating.value = true
  problem.value = null
  try {
    const location = await currentLocation({ highAccuracy: props.highAccuracy })
    modelValue.value = { lng: location.lng, lat: location.lat }
    emit('located', location)
  } catch (error) {
    problem.value = locationProblem(error)
    emit('locateFailed', { reason: problem.value, message: t(`dataviews.widgetLocation.problems.${problem.value}`) })
  } finally {
    locating.value = false
  }
}

onMounted(() => {
  if (props.auto && !modelValue.value) void locate()
})

const coordinates = computed(() => {
  const point = modelValue.value
  if (!point) return ''
  return `${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}`
})

defineExpose({ locate })
</script>

<template>
  <div class="flex w-full flex-wrap items-center gap-2">
    <UButton
      :icon="icon || 'i-lucide-locate-fixed'"
      :label="label || t(modelValue ? 'dataviews.widgetLocation.again' : 'dataviews.widgetLocation.mark')"
      :color="color"
      :variant="variant ?? (modelValue ? 'outline' : undefined)"
      :size="size"
      :loading="locating"
      :disabled="disabled"
      @click="locate"
    />
    <span
      v-if="locating"
      class="text-sm text-muted"
    >{{ t('dataviews.widgetLocation.locating') }}</span>
    <span
      v-else-if="problem"
      class="text-sm text-error"
    >{{ t(`dataviews.widgetLocation.problems.${problem}`) }}</span>
    <span
      v-else-if="showCoordinates && coordinates"
      class="font-mono text-sm text-muted tabular-nums"
    >{{ coordinates }}</span>
    <span
      v-else-if="showCoordinates"
      class="text-sm text-muted"
    >{{ t('dataviews.widgetLocation.none') }}</span>
  </div>
</template>
