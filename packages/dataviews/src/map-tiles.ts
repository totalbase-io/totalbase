/**
 * The base layer every map in the instance draws (Specification_DataViews.md
 * §5.4) - MAP DataViews, the map widgets, dashboard MAP widgets - built from
 * the `maps.tiles` / `maps.mapbox_token` / `maps.mapbox_style` settings.
 * Mapbox comes as raster tiles (its Static Tiles API) in the same Leaflet
 * maps; its token is a public one, meant for the browser. Mapbox without a
 * token keeps OpenStreetMap.
 */
export interface MapTileLayer {
  provider: "OPENSTREETMAP" | "MAPBOX";
  /** A Leaflet tile URL template ({s}, {z}, {x}, {y}, {r}). */
  url: string;
  /** HTML - the attribution each provider requires. */
  attribution: string;
  tileSize: number;
  zoomOffset: number;
  maxZoom: number;
}

const OPENSTREETMAP: MapTileLayer = {
  provider: "OPENSTREETMAP",
  url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  tileSize: 256,
  zoomOffset: 0,
  maxZoom: 19,
};

export function mapTileLayer(settings: { tiles: string; mapboxToken: string; mapboxStyle: string }): MapTileLayer {
  if (settings.tiles !== "MAPBOX" || !settings.mapboxToken) return OPENSTREETMAP;
  return {
    provider: "MAPBOX",
    // The style is validated as username/style_id when it's saved; the token is encoded anyway.
    url: `https://api.mapbox.com/styles/v1/${settings.mapboxStyle}/tiles/512/{z}/{x}/{y}{r}?access_token=${encodeURIComponent(settings.mapboxToken)}`,
    attribution:
      '&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ' +
      '<strong><a href="https://www.mapbox.com/map-feedback/" target="_blank" rel="noopener">Improve this map</a></strong>',
    // Mapbox serves 512px tiles: one zoom level down keeps the same scale as 256px ones.
    tileSize: 512,
    zoomOffset: -1,
    maxZoom: 22,
  };
}
