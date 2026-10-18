<script setup lang="ts">
/**
 * `UMap` adapter for a `point` COLUMN field - not a real Nuxt UI
 * component (there isn't one), same "the name exists only as this
 * adapter slot" convention `UJson`/`UColorSelect` already use. A single
 * draggable pin, not DataViewMap.vue's own multi-pin/cluster rendering
 * (that one plots many resolved rows at once; this is one field's own
 * value) - built from the same Leaflet conventions as that component
 * (dynamic `.default` import for SSR-safety, `L.map()`/`L.tileLayer()`/
 * `L.marker()`), just simpler.
 *
 * `{ lng, lat }` in, `{ lng, lat }` out - packages/database's own `point`
 * type parser/packages/query-engine's own `pointLiteral` already agree
 * on this exact shape as the column's real wire value, so this widget
 * needs no adapter conversion the way `WidgetInputDate.vue` does for
 * reka-ui's `CalendarDate` - only the click/drag -> Leaflet's own
 * `[lat, lng]` argument order needs translating, inline below.
 */
import 'leaflet/dist/leaflet.css'
import type { Map as LeafletMap, Marker } from 'leaflet'
import { currentLocation, locationProblem, type DeviceLocation, type LocationProblem } from '~/utils/device-location'

export interface MapPoint { lng: number, lat: number }

const { t } = useI18n()
const modelValue = defineModel<MapPoint | null | undefined>()
const props = withDefaults(defineProps<{
  /** A My location button over the map - the device's position as the pin, still draggable. */
  locate?: boolean
  /** Captures the device's position when the field opens with no value. */
  locateOnOpen?: boolean
  disabled?: boolean
}>(), { locate: true, locateOnOpen: false, disabled: false })
const emit = defineEmits<{
  located: [location: DeviceLocation]
  locateFailed: [error: { reason: LocationProblem, message: string }]
}>()
const toast = useToast()

const el = ref<HTMLDivElement | null>(null)
let map: LeafletMap | null = null
let marker: Marker | null = null
let resizeObserver: ResizeObserver | null = null

// No pin yet - a sensible, non-arbitrary default view. Buenos Aires has
// no special meaning here; it's just centered enough on land at a zoom
// that reads as "the whole world," so a fresh field doesn't open on
// empty ocean.
const DEFAULT_CENTER: [number, number] = [20, 0]
const DEFAULT_ZOOM = 2
const PIN_ZOOM = 13

/**
 * The pin: an SVG of our own in the theme's primary color - Leaflet's default marker is an image it looks for
 * beside its script, which the bundle doesn't ship (a broken image).
 */
const PIN_HTML = `<svg width="28" height="40" viewBox="0 0 28 40" xmlns="http://www.w3.org/2000/svg">
  <path d="M14 0C6.3 0 0 6.3 0 14c0 10.5 14 26 14 26s14-15.5 14-26c0-7.7-6.3-14-14-14z" style="fill: var(--ui-primary)" stroke="white" stroke-width="1.5"/>
  <circle cx="14" cy="14" r="5" fill="white"/>
</svg>`

/** A value set on the map itself (a click, a drag) - the view stays where the person put it. */
let fromMap = false
function setFromMap(point: MapPoint) {
  fromMap = true
  modelValue.value = point
}

async function placeMarker(point: MapPoint, center: boolean) {
  if (!map) return
  const { default: L } = await import('leaflet')
  // Leaflet loads asynchronously: the map may be gone by now (unmounted - a record page remounts its form as the
  // record loads), and another call may have placed the marker meanwhile.
  if (!map) return
  if (marker) {
    marker.setLatLng([point.lat, point.lng])
  } else {
    const icon = L.divIcon({ html: PIN_HTML, className: '', iconSize: [28, 40], iconAnchor: [14, 40] })
    marker = L.marker([point.lat, point.lng], { draggable: !props.disabled, icon, title: t('common.selectedPoint'), alt: t('common.selectedPoint') })
    marker.on('dragend', () => {
      const pos = marker!.getLatLng()
      setFromMap({ lng: pos.lng, lat: pos.lat })
    })
    marker.addTo(map)
  }
  // A value from outside - the record loaded after the map was made, another field - is brought into view.
  if (center) map.setView([point.lat, point.lng], Math.max(map.getZoom(), PIN_ZOOM))
}

function removeMarker() {
  marker?.remove()
  marker = null
}

watch(() => modelValue.value, (point) => {
  const center = !fromMap
  fromMap = false
  if (point) placeMarker(point, center)
  else removeMarker()
}, { deep: true })

const { baseLayer, tiles } = useMapTiles()

onMounted(async () => {
  if (!el.value) return
  const { default: L } = await import('leaflet')

  const base = await baseLayer(L)
  if (!el.value) return
  // Read after the awaits: a record's value that arrived meanwhile found no map to pin yet.
  const initial = modelValue.value
  // Empty: the instance's default view (Settings > Maps), else the world (T57).
  const fallback = (await tiles()).defaultView
  if (!el.value) return
  // A finger drags the page, not the map (two fingers pinch it), and the wheel scrolls the page - the map never
  // traps a form's scroll (T57); its +/- and a tap still work.
  map = L.map(el.value, { dragging: !L.Browser.mobile, scrollWheelZoom: false }).setView(
    initial ? [initial.lat, initial.lng] : fallback ? [fallback.lat, fallback.lng] : DEFAULT_CENTER,
    initial ? PIN_ZOOM : fallback ? fallback.zoom : DEFAULT_ZOOM
  )
  // The instance's tiles - OpenStreetMap or Mapbox (Settings > Features > Maps).
  base.addTo(map)

  if (initial) await placeMarker(initial, false)

  // The container's height comes from the Design form (a style on this
  // root) and can change after mount - the Design form's Preview, a
  // rotation - and Leaflet only measures it on its own.
  resizeObserver = new ResizeObserver(() => map?.invalidateSize())
  resizeObserver.observe(el.value)

  map.on('click', (e) => {
    if (props.disabled) return
    setFromMap({ lng: e.latlng.lng, lat: e.latlng.lat })
  })
})

// --- My location (utils/device-location.ts) -----------------------------------

const locating = ref(false)
/** The device's position as the pin, brought into view; a failure keeps the pin where it was and says why. */
async function findMe() {
  if (props.disabled || locating.value) return
  locating.value = true
  try {
    const location = await currentLocation()
    modelValue.value = { lng: location.lng, lat: location.lat }
    emit('located', location)
  } catch (error) {
    const reason = locationProblem(error)
    const message = t(`dataviews.widgetLocation.problems.${reason}`)
    toast.add({ title: message, color: 'warning' })
    emit('locateFailed', { reason, message })
  } finally {
    locating.value = false
  }
}

onMounted(() => {
  if (props.locateOnOpen && !modelValue.value) void findMe()
})

defineExpose({ locate: findMe })

onUnmounted(() => {
  resizeObserver?.disconnect()
  map?.remove()
  map = null
  marker = null
})
</script>

<template>
  <!-- Leaflet goes on the inner element, whose class never changes: it adds its own classes (leaflet-container...) by
  hand, and Vue rewrites an element's class whenever its bound classes change - this root's, its own and the
  renderer's (h-full, w-full) - which would wipe them and leave the map blank. -->
  <div
    class="relative w-full h-64 overflow-hidden rounded-md border border-default"
    :class="disabled ? 'opacity-75 pointer-events-none' : ''"
  >
    <div
      ref="el"
      class="size-full"
    />
    <!-- Over Leaflet's panes (z-index up to 1000), under the page's overlays. -->
    <UButton
      v-if="locate && !disabled"
      class="absolute top-2 right-2 z-[1001]"
      icon="i-lucide-locate-fixed"
      :aria-label="t('dataviews.widgetLocation.myLocation')"
      color="neutral"
      variant="solid"
      size="sm"
      :loading="locating"
      @click="findMe"
    />
  </div>
</template>
