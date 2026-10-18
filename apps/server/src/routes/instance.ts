import type { FastifyInstance } from "fastify";
import { isUiLanguage, DEFAULT_UI_LANGUAGE, LOGIN_CARD_POSITIONS, LOGIN_LAYOUTS, UI_LANGUAGES } from "@totalbase/shared";
import { dataEnvelope, type RouteDoc } from "@totalbase/openapi";
import type { AppContext } from "../context.js";

const doc = (openapi: RouteDoc) => ({ config: { openapi } });

/** Where a PUBLIC file's content is served - the browser loads it with no credentials. */
const publicFileUrl = (id: string) => (id ? `/api/totalbase/table/files/${id}` : null);

/**
 * What a page needs to know about the instance before anyone signs in, and
 * on every page after: the language it speaks (`system.language`,
 * Specification_Admin_UI.md §14) and its branding (§4.1.1) - its name, its
 * mark and how the sign-in page is laid out. Public, and nothing else: no
 * version, no other setting. The colors and the custom CSS travel as a
 * stylesheet instead (/admin/theme.css).
 */
export function registerInstanceRoutes(app: FastifyInstance, context: AppContext): void {
  app.get(
    "/api/instance",
    doc({
      summary: "The instance's public presentation",
      description: "The default UI language, the instance's name and mark, and the sign-in page's layout - what the sign-in and other public pages are shown with.",
      tags: ["auth"],
      access: "public",
      response: {
        status: "200",
        schema: dataEnvelope({
          type: "object",
          properties: {
            language: { type: "string", enum: UI_LANGUAGES.map((l) => l.code) },
            name: { type: "string", description: "`system.instance_name`." },
            logoUrl: { type: ["string", "null"], description: "The operator's mark (`system.logo`, a public file), or null for the built-in one." },
            login: {
              type: "object",
              properties: {
                layout: { type: "string", enum: [...LOGIN_LAYOUTS] },
                cardPosition: { type: "string", enum: [...LOGIN_CARD_POSITIONS], description: "Where the IMAGE layout's card sits on a wide screen." },
                backgroundUrl: { type: ["string", "null"], description: "The IMAGE layout's background (and the company panel's), a public file." },
                headline: { type: "string" },
                intro: { type: "string" },
                providers: {
                  type: "array",
                  description: "The auth providers shown on the sign-in page (enabled, Show on the sign-in page on), in their configured order.",
                  items: {
                    type: "object",
                    properties: {
                      slug: { type: "string" },
                      name: { type: "string" },
                      type: { type: "string", enum: ["GOOGLE", "GITHUB", "OIDC"] },
                      signInUrl: { type: "string", description: "Where its button leads: `/api/auth/oauth/{slug}?redirect_to=<public URL>/admin/auth/oauth`." },
                    },
                    required: ["slug", "name", "type", "signInUrl"],
                  },
                },
              },
              required: ["layout", "cardPosition", "backgroundUrl", "headline", "intro", "providers"],
            },
          },
          required: ["language", "name", "logoUrl", "login"],
        }),
      },
    }),
    async () => {
      const [language, name, logo, layout, background, headline, intro, cardPosition, providers] = await Promise.all([
        context.settings.get("system.language"),
        context.settings.get("system.instance_name"),
        context.settings.get("system.logo"),
        context.settings.get("appearance.login_layout"),
        context.settings.get("appearance.login_background"),
        context.settings.get("appearance.login_headline"),
        context.settings.get("appearance.login_intro"),
        context.settings.get("appearance.login_card_position"),
        context.authProviders.list(),
      ]);
      const portalCallback = encodeURIComponent(await context.oauth.portalCallbackUrl());
      return {
        data: {
          language: isUiLanguage(language) ? language : DEFAULT_UI_LANGUAGE,
          name,
          logoUrl: publicFileUrl(logo),
          login: {
            layout,
            cardPosition,
            backgroundUrl: publicFileUrl(background),
            headline,
            intro,
            providers: providers
              .filter((p) => p.enabled && p.showOnSignIn)
              .map((p) => ({ slug: p.slug, name: p.name, type: p.type, signInUrl: `/api/auth/oauth/${p.slug}?redirect_to=${portalCallback}` })),
          },
        },
      };
    },
  );
}
