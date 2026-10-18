import type { TileLayer } from 'leaflet'

/** The base layer every map draws - GET /app/api/map-tiles (Specification_DataViews.md §5.4). */
export interface MapTileLayer {
  provider: 'OPENSTREETMAP' | 'MAPBOX'
  url: string
  attribution: string
  tileSize: number
  zoomOffset: number
  maxZoom: number
  /** Where an empty map field opens - Settings > Maps; null: the whole world. */
  defaultView?: { lat: number, lng: number, zoom: number } | null
}

const OPENSTREETMAP: MapTileLayer = {
  provider: 'OPENSTREETMAP',
  url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  tileSize: 256,
  zoomOffset: 0,
  maxZoom: 19
}

// One request per page load, shared by every map on it; a change in Settings applies on the next load.
let pending: Promise<MapTileLayer> | null = null

/**
 * The instance's map tiles (OpenStreetMap, or Mapbox raster tiles) for the
 * Leaflet maps - DataViewMap, MapViewPicker, WidgetMap, DashboardWidgetMap.
 * Call it in setup; `await baseLayer(L)` before creating the map. A failed
 * request keeps OpenStreetMap: a map is never left without a background.
 */
export function useMapTiles() {
  const api = useAppApi()
  function tiles(): Promise<MapTileLayer> {
    pending ??= api.get<MapTileLayer>('/map-tiles').then(r => r.data).catch(() => {
      pending = null
      return OPENSTREETMAP
    })
    return pending
  }
  /**
   * The instance's base layer, ready to add. Await it before creating the
   * map - the layer sets the map's maxZoom, which markercluster needs from
   * the start - then check the component is still mounted.
   */
  async function baseLayer(L: typeof import('leaflet')): Promise<TileLayer> {
    const layer = await tiles()
    return L.tileLayer(layer.url, { attribution: layer.attribution, tileSize: layer.tileSize, zoomOffset: layer.zoomOffset, maxZoom: layer.maxZoom })
  }
  return { tiles, baseLayer }
}

/** Forget the cached tiles - after an administrator changes them in Settings. */
export function resetMapTiles(): void {
  pending = null
}
