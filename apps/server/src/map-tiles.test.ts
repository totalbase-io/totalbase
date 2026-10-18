import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { loadServerEnv } from "./env.js";
import { setupTestApp } from "./test-support.js";

/**
 * Map tiles (Specification_DataViews.md §5.4): one instance-wide base layer -
 * OpenStreetMap, or Mapbox raster tiles with a public token, which is a
 * normal setting precisely because it reaches every viewer's browser: a
 * secret (sk.) token is refused.
 */
describe("Map tiles", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let token: string;

  const tiles = () => app.inject({ method: "GET", url: "/app/api/map-tiles", headers: { authorization: `Bearer ${token}` } });
  const patch = (data: Record<string, unknown>) =>
    app.inject({ method: "PATCH", url: "/admin/api/settings/maps", headers: { authorization: `Bearer ${token}` }, payload: { data } });

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    const env = loadServerEnv();
    token = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
  });

  afterAll(async () => {
    for (const key of ["maps.tiles", "maps.mapbox_token", "maps.mapbox_style", "maps.default_view"] as const) await context.settings.reset(key);
    await app.close();
    await database.close();
  });

  it("is OpenStreetMap by default, and needs a portal user", async () => {
    expect((await app.inject({ method: "GET", url: "/app/api/map-tiles" })).statusCode).toBe(401);
    const res = await tiles();
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ provider: "OPENSTREETMAP", tileSize: 256 });
  });

  it("keeps OpenStreetMap for Mapbox without a token, then serves Mapbox tiles with one", async () => {
    expect((await patch({ tiles: "MAPBOX" })).statusCode).toBe(200);
    expect((await tiles()).json().data.provider).toBe("OPENSTREETMAP");
    expect((await patch({ mapbox_token: "pk.eyJ1IjoidGVzdCJ9.abc", mapbox_style: "mapbox/light-v11" })).statusCode).toBe(200);
    const layer = (await tiles()).json().data;
    expect(layer).toMatchObject({ provider: "MAPBOX", tileSize: 512, zoomOffset: -1 });
    expect(layer.url).toContain("/styles/v1/mapbox/light-v11/tiles/512/");
  });

  it("refuses a secret token and a malformed style", async () => {
    const secret = await patch({ mapbox_token: "sk.eyJ1IjoidGVzdCJ9.abc" });
    expect(secret.statusCode).toBe(400);
    expect(JSON.stringify(secret.json())).toContain("secret token");
    expect((await patch({ mapbox_style: "https://evil.example/style" })).statusCode).toBe(400);
    expect((await patch({ tiles: "GOOGLE" })).statusCode).toBe(400);
  });

  it("gives where an empty map field opens - the world without one, refusing a malformed view (T57)", async () => {
    expect((await tiles()).json().data.defaultView).toBeNull();
    expect((await patch({ default_view: "-24.79, -65.41, 12" })).statusCode).toBe(200);
    expect((await tiles()).json().data.defaultView).toEqual({ lat: -24.79, lng: -65.41, zoom: 12 });
    expect((await patch({ default_view: "Salta" })).statusCode).toBe(400);
    expect((await patch({ default_view: "95, 0, 3" })).statusCode).toBe(400);
  });
});
