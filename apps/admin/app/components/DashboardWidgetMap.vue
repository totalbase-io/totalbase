<script setup lang="ts">
/**
 * The MAP dashboard widget's body - query rows plotted as circle markers
 * on an OpenStreetMap base layer. Same Leaflet loading as DataViewMap.vue
 * (dynamic import inside onMounted, `.default` so the markercluster
 * plugin's late additions are visible - see that file's comment).
 *
 * Tooltips are built as text nodes, never HTML strings: labels come
 * straight from query results.
 *
 * A clickable map (D6) hands its card the clicked point's row, its tooltip
 * ending with what a click does; on a touch device the first tap only opens
 * the tooltip, a second tap on the same point clicks it.
 */
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import type { LayerGroup, Map as LeafletMap } from 'leaflet'
import type { MapPoint } from '~/utils/dashboard-builders'

const props = defineProps<{
  points: MapPoint[]
  /** Fallback for points without their own `_color`. */
  color: string
  cluster: boolean
  /** A click on a point does something (D6): the tooltip's last line. Null - not clickable. */
  clickHint?: string | null
  /** A first tap only opens the tooltip (a touch device). */
  confirmTap?: boolean
}>()

const emit = defineEmits<{ select: [row: Record<string, unknown>] }>()

const el = ref<HTMLDivElement | null>(null)
let map: LeafletMap | null = null
let layer: LayerGroup | null = null
let resizeObserver: ResizeObserver | null = null

function tooltip(point: MapPoint): HTMLElement {
  const node = document.createElement('div')
  node.textContent = [point.label, point.valueText ?? ''].filter(Boolean).join(' · ')
  if (props.clickHint) {
    const hint = document.createElement('div')
    hint.textContent = props.clickHint
    hint.style.cssText = 'margin-top:4px;font-size:11px;opacity:0.7'
    node.appendChild(hint)
  }
  return node
}

/** The point a first tap opened (a touch device) - a second tap on it clicks it. */
let armed: MapPoint | null = null
function onPointClick(point: MapPoint) {
  if (!props.clickHint) return
  if (props.confirmTap && armed !== point) {
    armed = point
    return
  }
  armed = null
  emit('select', point.row)
}

async function render() {
  if (!map) return
  const { default: L } = await import('leaflet')
  layer?.remove()
  layer = props.cluster
    ? (L as unknown as { markerClusterGroup: () => LayerGroup }).markerClusterGroup()
    : L.layerGroup()

  // Size by value: sqrt keeps the circle AREA proportional to the value.
  const max = Math.max(0, ...props.points.map(p => Math.abs(p.value ?? 0)))
  for (const point of props.points) {
    const radius = point.value !== null && max > 0 ? 4 + 14 * Math.sqrt(Math.abs(point.value) / max) : 6
    // Per-point color from the query's `_color` column, else the widget's color.
    const color = point.color ?? props.color
    const marker = L.circleMarker([point.lat, point.lng], {
      radius,
      color,
      fillColor: color,
      fillOpacity: 0.45,
      weight: 1
    })
    if (point.label || point.value !== null || props.clickHint) marker.bindTooltip(tooltip(point))
    if (props.clickHint) marker.on('click', () => onPointClick(point))
    layer.addLayer(marker)
  }
  map.addLayer(layer)
  if (props.points.length > 0) {
    map.fitBounds(L.latLngBounds(props.points.map(p => [p.lat, p.lng] as [number, number])), { padding: [24, 24], maxZoom: 12 })
  }
}

const { baseLayer } = useMapTiles()

onMounted(async () => {
  if (!el.value) return
  const { default: L } = await import('leaflet')
  await import('leaflet.markercluster')
  const base = await baseLayer(L)
  if (!el.value) return
  map = L.map(el.value, { attributionControl: true }).setView([20, 0], 2)
  // The instance's tiles - OpenStreetMap or Mapbox (Settings > Features > Maps).
  base.addTo(map)
  // The card is resized by GridStack (and the drawer preview by the
  // layout) - Leaflet only measures its container on init.
  resizeObserver = new ResizeObserver(() => map?.invalidateSize())
  resizeObserver.observe(el.value)
  await render()
})

watch(() => [props.points, props.color, props.cluster, props.clickHint], render, { deep: true })

onUnmounted(() => {
  resizeObserver?.disconnect()
  map?.remove()
  map = null
  layer = null
})
</script>

<template>
  <div
    ref="el"
    class="size-full rounded-md"
  />
</template>
