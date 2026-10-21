import type { FastifyInstance } from "fastify";
import { mapTileLayer } from "@totalbase/dataviews";
import type { AppContext } from "../context.js";
import { requireAppAccess } from "../auth-guards.js";

/**
 * The base layer every map draws (DataViews.md §5.4), for any
 * portal user: a MAP DataView, a map field, a dashboard map. The Mapbox
 * token in it is a public one - restricted by URL in the Mapbox account,
 * never a secret.
 */
export function registerAppMapTilesRoutes(app: FastifyInstance, context: AppContext): void {
  app.get("/app/api/map-tiles", { preHandler: requireAppAccess(context) }, async () => {
    const [tiles, mapboxToken, mapboxStyle, defaultView] = await Promise.all([
      context.settings.get("maps.tiles"),
      context.settings.get("maps.mapbox_token"),
      context.settings.get("maps.mapbox_style"),
      context.settings.get("maps.default_view"),
    ]);
    // Where an empty map field opens (T57) - null: the whole world.
    const [lat, lng, zoom] = defaultView ? defaultView.split(",").map(Number) : [];
    const view = lat !== undefined && lng !== undefined && zoom !== undefined ? { lat, lng, zoom } : null;
    return { data: { ...mapTileLayer({ tiles, mapboxToken, mapboxStyle }), defaultView: view } };
  });
}
