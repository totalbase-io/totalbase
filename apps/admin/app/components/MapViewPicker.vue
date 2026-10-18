<script setup lang="ts">
/**
 * Wizard step "Map layout" 's own mini-Leaflet - lets the builder pan/
 * zoom to pick the fixed center/zoom a MAP DataView's map always opens
 * at (`view_config.map_view`, types/dataview.ts's `resolveMapView` doc
 * comment: this fixed view always wins over auto-fit-to-pins, by the
 * chat's own choice). A crosshair pinned to the viewport's own center
 * (CSS, not a real Leaflet marker) shows what "center" means while
 * panning - same dynamic-import-in-onMounted discipline DataViewMap.vue
 * follows, for the same SSR reason.
 */
import 'leaflet/dist/leaflet.css'
import type { Map as LeafletMap } from 'leaflet'
import type { MapViewConfig } from '~/types/dataview'

const modelValue = defineModel<MapViewConfig>({ required: true })

const el = ref<HTMLDivElement | null>(null)
let map: LeafletMap | null = null
let suppressEmit = false

const { baseLayer } = useMapTiles()

onMounted(async () => {
  if (!el.value) return
  const { default: L } = await import('leaflet')
  const base = await baseLayer(L)
  if (!el.value) return
  map = L.map(el.value).setView([modelValue.value.centerLat, modelValue.value.centerLng], modelValue.value.zoom)
  // The instance's tiles - OpenStreetMap or Mapbox (Settings > Features > Maps).
  base.addTo(map)
  map.on('moveend zoomend', () => {
    if (suppressEmit || !map) return
    const center = map.getCenter()
    modelValue.value = { centerLat: center.lat, centerLng: center.lng, zoom: map.getZoom() }
  })
})

// A later external change to the same model (e.g. resetting the step)
// re-centers the map without re-emitting right back - `suppressEmit`
// guards the resulting `moveend` `setView` itself fires.
watch(modelValue, (view) => {
  if (!map) return
  suppressEmit = true
  map.setView([view.centerLat, view.centerLng], view.zoom)
  requestAnimationFrame(() => {
    suppressEmit = false
  })
})

onUnmounted(() => {
  map?.remove()
  map = null
})
</script>

<template>
  <div class="relative h-56 w-full overflow-hidden rounded-lg border border-default">
    <div
      ref="el"
      class="size-full"
    />
    <!-- Crosshair - purely visual, marks the viewport's own center (= the picked center) while panning. -->
    <div class="pointer-events-none absolute inset-0 flex items-center justify-center">
      <UIcon
        name="i-lucide-plus"
        class="size-5 text-highlighted drop-shadow"
      />
    </div>
  </div>
</template>
