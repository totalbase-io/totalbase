import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { setupTestApp } from "../test-support.js";

const KEYS = [
  "appearance.primary_color",
  "appearance.neutral_color",
  "appearance.custom_css",
  "system.logo",
  "appearance.login_layout",
  "appearance.login_card_position",
  "appearance.login_background",
  "appearance.login_headline",
  "system.instance_name",
] as const;

/**
 * The operator's branding (Specification_Admin_UI.md §4.1.1): the public
 * stylesheet /admin/theme.css, the public /api/instance presentation, and
 * what the appearance.* settings accept.
 */
describe("Appearance: /admin/theme.css, /api/instance and the appearance.* settings", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let publicImageId: string;
  let privateImageId: string;
  let publicTextId: string;

  const patch = (group: string, data: Record<string, unknown>) =>
    app.inject({ method: "PATCH", url: `/admin/api/settings/${group}`, headers: { authorization: `Bearer ${adminToken}` }, payload: { data } });

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    publicImageId = (await context.filesAdmin.upload({ filename: "theme-public.png", declaredContentType: "image/png", content: png, visibility: "PUBLIC" })).id;
    privateImageId = (await context.filesAdmin.upload({ filename: "theme-private.png", declaredContentType: "image/png", content: png, visibility: "PRIVATE" })).id;
    publicTextId = (await context.filesAdmin.upload({ filename: "theme.txt", declaredContentType: "text/plain", content: Buffer.from("x"), visibility: "PUBLIC" })).id;
  });

  afterAll(async () => {
    for (const key of KEYS) await context.settings.reset(key);
    for (const id of [publicImageId, privateImageId, publicTextId]) await context.filesAdmin.remove(id).catch(() => undefined);
    await app.close();
    await database.close();
  });

  it("serves the stylesheet public, as text/css, cached on its ETag with 304 on a match", async () => {
    await context.settings.reset("appearance.primary_color");
    await context.settings.reset("appearance.custom_css");
    const res = await app.inject({ method: "GET", url: "/admin/theme.css" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/css");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.body).not.toContain("--ui-color-primary");
    const etag = res.headers.etag as string;
    expect(etag).toMatch(/^".+"$/);
    const again = await app.inject({ method: "GET", url: "/admin/theme.css", headers: { "if-none-match": etag } });
    expect(again.statusCode).toBe(304);
  });

  it("writes the primary color's shades, then the custom CSS verbatim, and a change changes the ETag", async () => {
    const before = (await app.inject({ method: "GET", url: "/admin/theme.css" })).headers.etag;
    expect((await patch("appearance", { primary_color: "#0F766E", custom_css: ":root { --ui-radius: 0 }\nhtml[data-surface=\"app\"] { font-family: serif }" })).statusCode).toBe(200);
    const res = await app.inject({ method: "GET", url: "/admin/theme.css" });
    expect(res.body).toContain("--ui-color-primary-500: oklch(");
    expect(res.body).toContain("--ui-color-primary-950: oklch(");
    expect(res.body.indexOf("--ui-color-primary-50:")).toBeLessThan(res.body.indexOf(":root { --ui-radius: 0 }"));
    expect(res.body).toContain('html[data-surface="app"] { font-family: serif }');
    expect(res.headers.etag).not.toBe(before);
  });

  it("writes a neutral other than slate as its palette, and refuses a name it doesn't know", async () => {
    await context.settings.reset("appearance.neutral_color");
    expect((await app.inject({ method: "GET", url: "/admin/theme.css" })).body).not.toContain("--ui-color-neutral");
    expect((await patch("appearance", { neutral_color: "zinc" })).statusCode).toBe(200);
    const res = await app.inject({ method: "GET", url: "/admin/theme.css" });
    expect(res.body).toContain("--ui-color-neutral-50: oklch(");
    expect(res.body).toContain("--ui-color-neutral-950: oklch(14.1% 0.005 285.823);");
    expect((await patch("appearance", { neutral_color: "blue" })).statusCode).toBe(400);
    await context.settings.reset("appearance.neutral_color");
  });

  it("refuses what the settings may not hold: a non-hex color, @import, an unknown layout, over-long texts", async () => {
    const refused = async (data: Record<string, unknown>, message: RegExp) => {
      const res = await patch("appearance", data);
      expect(res.statusCode, JSON.stringify(data)).toBe(400);
      expect(res.json().errors[0].message).toMatch(message);
    };
    await refused({ primary_color: "blue" }, /#rrggbb/);
    await refused({ primary_color: "#fff" }, /#rrggbb/);
    await refused({ custom_css: "@import url(https://x.example/a.css);" }, /@import/);
    await refused({ custom_css: "a{}".repeat(30_000) }, /64 KB/);
    await refused({ login_layout: "CAROUSEL" }, /SPLIT, SIMPLE, PANEL, IMAGE/);
    await refused({ login_card_position: "TOP" }, /LEFT, CENTER, RIGHT/);
    await refused({ login_headline: "x".repeat(121) }, /120/);
    await refused({ login_intro: "x".repeat(301) }, /300/);
  });

  it("refuses a logo that isn't a file id - it is General's (system.logo), beside the name", async () => {
    const res = await patch("system", { logo: "not-a-uuid" });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].message).toMatch(/file id/);
  });

  it("takes a PUBLIC image as the logo or the background - never a private file, a non-image or a missing one", async () => {
    expect((await patch("system", { logo: publicImageId })).statusCode).toBe(200);
    expect((await patch("appearance", { login_background: publicImageId })).statusCode).toBe(200);
    for (const [group, key, id, message] of [
      ["system", "logo", privateImageId, /public/],
      ["appearance", "login_background", privateImageId, /public/],
      ["system", "logo", publicTextId, /image/],
      ["system", "logo", "00000000-0000-4000-8000-000000000000", /No file/],
    ] as const) {
      const res = await patch(group, { [key]: id });
      expect(res.statusCode, `${key}=${id}`).toBe(400);
      expect(res.json().errors[0].message).toMatch(message);
    }
  });

  it("presents the instance public: name, logo, sign-in layout and texts, with public file URLs", async () => {
    expect((await patch("system", { instance_name: "Acme Portal", logo: publicImageId })).statusCode).toBe(200);
    expect((await patch("appearance", { login_layout: "IMAGE", login_background: publicImageId, login_headline: "Welcome to Acme" })).statusCode).toBe(200);
    const res = await app.inject({ method: "GET", url: "/api/instance" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      name: "Acme Portal",
      logoUrl: `/api/totalbase/table/files/${publicImageId}`,
      login: { layout: "IMAGE", backgroundUrl: `/api/totalbase/table/files/${publicImageId}`, headline: "Welcome to Acme", intro: "" },
    });
    // The mark loads with no credentials - it is on the sign-in page.
    expect((await app.inject({ method: "GET", url: res.json().data.logoUrl })).statusCode).toBe(200);

    await patch("system", { logo: "" });
    await patch("appearance", { login_layout: "SPLIT", login_background: "", login_headline: "" });
    await context.settings.reset("system.instance_name");
    expect((await app.inject({ method: "GET", url: "/api/instance" })).json().data).toMatchObject({
      name: "TotalBase",
      logoUrl: null,
      login: { layout: "SPLIT", backgroundUrl: null },
    });
  });

  it("only an administrator writes the appearance; anyone reads the sheet and the presentation", async () => {
    expect((await app.inject({ method: "PATCH", url: "/admin/api/settings/appearance", payload: { data: { primary_color: "#000000" } } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/instance" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/admin/theme.css" })).statusCode).toBe(200);
  });
});
