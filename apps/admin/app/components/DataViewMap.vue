<script setup lang="ts">
/**
 * The `MAP` layout's own render (DataViewGrid.vue's own `isMap` branch) -
 * same "dumb, receives pins already resolved" split DataViewCard.vue
 * already follows for CARDS: every value shown here (name/description
 * text, lat/lng, icon/color) is resolved by the parent via the same
 * `computedValueResolver`/`formatCellPlainText` TABLE/CARDS already use
 * (build-dataview-columns.ts) - this component only plots the result.
 *
 * Leaflet touches `window`/`document` at import time (tile layer image
 * loading, DOM manipulation for its own controls) - same reason
 * PdfTemplateDesigner.vue's own pdfme Designer only ever imports dynamically
 * inside `onMounted()`, never at module scope, so this component stays
 * SSR-safe. `leaflet.markercluster` piggybacks on the `window.L` global
 * that plain `import 'leaflet'` sets up, so it's imported right after -
 * see its own README, this is the documented way to use it from a bundler.
 *
 * `leaflet`/`leaflet.markercluster`'s own CSS has no `window`/`document`
 * reference at all - safe to import statically like any other stylesheet.
 */
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import type { Map as LeafletMap, MarkerClusterGroup } from 'leaflet'
import { isValidColorValue, roleColorShade } from '~/types/permission'
import { DEFAULT_MAP_VIEW, type MapViewConfig } from '~/types/dataview'
import type { FormulaRichSegment } from '~/utils/formula-engine'

/** One resolved pin - `row` is passed back whole when its popup opens the record, same as a card's `row` (DataViewCardsView.vue). `name`/`description` are always the plain, flattened text (formatting stripped) - the same fallback every other layout gets; `nameRich`/`descriptionRich` are only set when that formula used a FORMAT function (BOLD/ITALIC/.../NEW_LINE), and the popup renders those through `useRichHtml` instead of the plain escaped text. */
export interface MapPin {
  key: string
  lat: number
  lng: number
  name: string
  nameRich?: FormulaRichSegment[]
  description: string | null
  descriptionRich?: FormulaRichSegment[]
  icon: string
  /** A plain `string`, not `RoleColor` - `colorFormula` can evaluate to anything (roleColorShade's own doc comment); `pinSvg` below is what actually validates it. */
  color: string
  row: Record<string, unknown>
}

const props = defineProps<{
  pins: MapPin[]
  mapView: MapViewConfig
}>()
// A pin's popup shows the record's title and opens it - what acts on the
// record (Clone, Delete...) is the record form's own "⋮" (AGENTS.md §25).
const emit = defineEmits<{ edit: [Record<string, unknown>] }>()
const { t } = useI18n()

const el = ref<HTMLDivElement | null>(null)
let map: LeafletMap | null = null
let clusterGroup: MarkerClusterGroup | null = null

/**
 * A `<UIcon>`-style pin as an inline SVG (Google Maps' own classic
 * teardrop marker shape) tinted with `roleColorShade` - a real hex/oklch
 * `fill`, not a CSS/Tailwind class (no cascade to grab one from inside a
 * plain `L.divIcon`'s detached HTML). Lucide's own icon glyphs aren't
 * loaded as raw SVG paths here (that's Nuxt Icon's own bundle, not
 * reachable from this string) - the pin shows a plain white dot instead
 * of the chosen icon glyph. Good enough for v1 (color still carries the
 * per-row signal - "a status by color"); a real
 * glyph-in-pin is a later polish, not blocking.
 */
function pinSvg(color: string): string {
  // Neither a real palette name nor a literal hex (roleColorShade's own
  // doc comment: a colorFormula can evaluate to anything) - a plain
  // white pin with a dashed red outline instead of the normal solid
  // teardrop, so a builder actually NOTICES their formula returned
  // garbage rather than it silently rendering as if nothing were wrong.
  if (!isValidColorValue(color)) {
    return `<svg width="28" height="40" viewBox="0 0 28 40" xmlns="http://www.w3.org/2000/svg">
      <path d="M14 0C6.3 0 0 6.3 0 14c0 10.5 14 26 14 26s14-15.5 14-26c0-7.7-6.3-14-14-14z" fill="white" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="3 2"/>
      <circle cx="14" cy="14" r="5" fill="#dc2626"/>
    </svg>`
  }
  const hex = roleColorShade(color, 'light')
  return `<svg width="28" height="40" viewBox="0 0 28 40" xmlns="http://www.w3.org/2000/svg">
    <path d="M14 0C6.3 0 0 6.3 0 14c0 10.5 14 26 14 26s14-15.5 14-26c0-7.7-6.3-14-14-14z" style="fill:${hex}" stroke="white" stroke-width="1.5"/>
    <circle cx="14" cy="14" r="5" fill="white"/>
  </svg>`
}

// The rich name/description of every pin, as safe HTML - the popup's
// text when the formula used a FORMAT function.
const richHtml = useRichHtml(() => props.pins.map(pin => ({ key: pin.key, titleRich: pin.nameRich, descriptionRich: pin.descriptionRich })))

/** The popup's content: the title and the description, the whole of it opening the record. Plain text is escaped; a rich one is already safe HTML (rich-text-render.ts). */
function popupHtml(pin: MapPin): string {
  const rich = richHtml.value[pin.key]
  const title = rich?.title ?? escapeHtml(pin.name)
  const descHtml = rich?.description ?? (pin.description ? escapeHtml(pin.description) : '')
  const desc = descHtml ? `<p class="tb-map-popup-desc">${descHtml}</p>` : ''
  return `<div class="tb-map-popup" role="button" tabindex="0" data-key="${escapeHtml(pin.key)}" aria-label="${escapeHtml(t('dataviews.layouts.openRecord', { name: pin.name }))}">
    <p class="tb-map-popup-title">${title}</p>
    ${desc}
  </div>`
}
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c]!)
}

// Only the latest render places markers: Leaflet loads async, and a pins
// change while a render is in flight would otherwise plot the pins twice.
const latestRender = useLatest()
async function renderPins() {
  if (!map || !clusterGroup) return
  const render = latestRender.next()
  const { default: L } = await import('leaflet')
  if (!render.isCurrent() || !clusterGroup) return
  clusterGroup.clearLayers()
  for (const pin of props.pins) {
    const icon = L.divIcon({
      html: pinSvg(pin.color),
      className: 'tb-map-pin',
      iconSize: [28, 40],
      iconAnchor: [14, 40],
      popupAnchor: [0, -36]
    })
    // Named for assistive technology - a pin's own name (T59).
    const marker = L.marker([pin.lat, pin.lng], { icon, title: pin.name, alt: pin.name })
    marker.bindPopup(popupHtml(pin))
    marker.on('popupopen', (e) => {
      const container = (e.popup as unknown as { getElement: () => HTMLElement }).getElement()
      const popup = container.querySelector<HTMLElement>('.tb-map-popup')
      if (!popup) return
      const open = () => emit('edit', pin.row)
      popup.addEventListener('click', open)
      popup.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          open()
        }
      })
    })
    clusterGroup.addLayer(marker)
  }
}

const { baseLayer } = useMapTiles()

onMounted(async () => {
  if (!el.value) return
  // `.default`, not the plain namespace (`import * as L`) - Vite/esbuild's
  // CJS interop snapshots a namespace import's own property list once,
  // at that module's first evaluation. `leaflet.markercluster` mutates
  // the SAME underlying Leaflet exports object, but only after that
  // snapshot already happened, adding `markerClusterGroup` as a
  // brand-new property - a plain namespace import never sees a property
  // that didn't exist yet when it was taken, so `L.markerClusterGroup`
  // reads as `undefined` ("is not a function"). `.default` is instead a
  // live reference to that same real object, so a property added to it
  // later by another module is visible through it immediately.
  const { default: L } = await import('leaflet')
  await import('leaflet.markercluster')

  const base = await baseLayer(L)
  if (!el.value) return

  map = L.map(el.value).setView([props.mapView.centerLat, props.mapView.centerLng], props.mapView.zoom)
  // The instance's tiles - OpenStreetMap or Mapbox (Settings > Features > Maps).
  base.addTo(map)
  // `as unknown as` - `leaflet.markercluster`'s own types augment the
  // `L` namespace via a side-effecting import; TS only sees that
  // augmentation when both packages are imported in the same file
  // (already true here), but the plain `import type` above resolves
  // against leaflet's own types alone.
  clusterGroup = (L as unknown as { markerClusterGroup: () => MarkerClusterGroup }).markerClusterGroup()
  map.addLayer(clusterGroup)
  await renderPins()
  // The author left the world view (no view of their own): the map frames its pins when it opens (T57).
  const view = props.mapView
  const ownView = view.centerLat !== DEFAULT_MAP_VIEW.centerLat || view.centerLng !== DEFAULT_MAP_VIEW.centerLng || view.zoom !== DEFAULT_MAP_VIEW.zoom
  if (!ownView && props.pins.length > 0 && clusterGroup && map) map.fitBounds(clusterGroup.getBounds(), { padding: [32, 32], maxZoom: 15 })
})

// The pins' rich text is rendered first (useRichHtml follows `pins`), so the
// markers are placed once it is there - and again when the theme changes it.
watch(richHtml, renderPins)
watch(() => props.mapView, (view) => {
  map?.setView([view.centerLat, view.centerLng], view.zoom)
})

onUnmounted(() => {
  map?.remove()
  map = null
  clusterGroup = null
})
</script>

<template>
  <div class="relative size-full min-h-96">
    <div
      ref="el"
      class="size-full rounded-lg"
    />
  </div>
</template>

<style>
/* Leaflet's own popup content div has no padding of its own to hang
these off - unscoped (no <style scoped>) so it reaches into Leaflet's
plain, non-Vue-templated popup DOM (built as an HTML string above). */
.tb-map-popup { min-width: 160px; cursor: pointer; }
.tb-map-popup:hover .tb-map-popup-title, .tb-map-popup:focus-visible .tb-map-popup-title { text-decoration: underline; }
.tb-map-popup-title { font-weight: 600; font-size: 0.875rem; margin: 0 0 2px; }
/* `pre-line` - a literal newline typed directly into a plain (non-rich) description formula still reads as a real line break, same as `NEW_LINE()`'s own `<br>` in the rich path already does (that one doesn't need this - `<br>` is a real element, not whitespace). */
.tb-map-popup-desc { font-size: 0.75rem; color: var(--ui-text-muted); margin: 0; white-space: pre-line; }
.tb-map-pin { background: transparent; border: none; }
</style>
