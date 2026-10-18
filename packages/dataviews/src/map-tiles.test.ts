import { describe, expect, it } from "vitest";
import { mapTileLayer } from "./map-tiles.js";

describe("mapTileLayer", () => {
  it("is OpenStreetMap by default, and for Mapbox without a token", () => {
    expect(mapTileLayer({ tiles: "OPENSTREETMAP", mapboxToken: "pk.abcdefghijkl", mapboxStyle: "mapbox/streets-v12" }).provider).toBe("OPENSTREETMAP");
    expect(mapTileLayer({ tiles: "MAPBOX", mapboxToken: "", mapboxStyle: "mapbox/streets-v12" }).provider).toBe("OPENSTREETMAP");
  });

  it("builds Mapbox raster tiles from the style and the encoded token", () => {
    const layer = mapTileLayer({ tiles: "MAPBOX", mapboxToken: "pk.ab&c", mapboxStyle: "acme/ck123" });
    expect(layer).toMatchObject({ provider: "MAPBOX", tileSize: 512, zoomOffset: -1 });
    expect(layer.url).toBe("https://api.mapbox.com/styles/v1/acme/ck123/tiles/512/{z}/{x}/{y}{r}?access_token=pk.ab%26c");
    expect(layer.attribution).toContain("Improve this map");
  });
});
