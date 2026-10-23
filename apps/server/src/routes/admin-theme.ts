import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { neutralColorCss, primaryColorCss } from "@totalbase/shared";
import type { AppContext } from "../context.js";

/**
 * The operator's stylesheet (Admin_UI.md §4.1.1): the primary
 * color's shades, the neutral's, then `appearance.custom_css` verbatim. Linked from the
 * SPA's <head> on every page it serves - the admin, the App, sign-in, the
 * public auth pages, embeds - so it is public, before any sign-in, and
 * loads before Vue mounts (no flash of the default look). Cached by the
 * browser on its ETag: `no-cache` makes it revalidate each load (one 304),
 * so a saved change shows on the next reload.
 *
 * Registered on the app itself, ahead of the SPA's static mount or dev
 * proxy, like /_icons: a static route beats their wildcard.
 */
export function registerAdminThemeRoutes(app: FastifyInstance, context: AppContext): void {
  app.get("/theme.css", async (request, reply) => {
    const [primaryColor, neutralColor, customCss] = await Promise.all([
      context.settings.get("appearance.primary_color"),
      context.settings.get("appearance.neutral_color"),
      context.settings.get("appearance.custom_css"),
    ]);
    const body = `/* TotalBase - Settings > Appearance */\n${primaryColorCss(primaryColor)}${neutralColorCss(neutralColor)}${customCss ? `${customCss}\n` : ""}`;
    const etag = `"${createHash("sha1").update(body).digest("hex")}"`;
    reply.header("etag", etag);
    reply.header("cache-control", "no-cache");
    if (request.headers["if-none-match"] === etag) return reply.code(304).send();
    reply.header("content-type", "text/css; charset=utf-8");
    return reply.send(body);
  });
}
