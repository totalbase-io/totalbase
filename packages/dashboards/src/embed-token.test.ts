import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { embedPreviewKey, isPreviewToken, signEmbedPreviewToken, signEmbedToken, verifyEmbedPreviewToken, verifyEmbedToken } from "./embed-token.js";

const SECRET = "s3cret-for-tests";
const NOW = 1_800_000_000;
const EMBED = "6f1c2c1e-6b7a-4c2e-9d6f-0a1b2c3d4e5f";
const claims = (extra: Partial<{ exp: number; params: Record<string, unknown> }> = {}) => ({ embed: EMBED, params: { customer: 42 }, exp: NOW + 600, ...extra });

function forge(header: object, payload: object, secret = SECRET) {
  const h = Buffer.from(JSON.stringify(header)).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${h}.${p}.${createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url")}`;
}

describe("embed tokens", () => {
  it("round-trips a signed token naming an embed - never a dashboard", () => {
    expect(verifyEmbedToken(signEmbedToken(claims(), SECRET), SECRET, 3600, NOW)).toEqual(claims());
    expect(() => verifyEmbedToken(forge({ alg: "HS256" }, { resource: { dashboard: EMBED }, exp: NOW + 60 }), SECRET, 3600, NOW)).toThrow(/names no embed/);
  });

  it("refuses another secret, a tampered payload, alg none and another algorithm", () => {
    const token = signEmbedToken(claims(), SECRET);
    expect(() => verifyEmbedToken(token, "other", 3600, NOW)).toThrow(/signature/);
    const [h, , s] = token.split(".");
    const tampered = `${h}.${Buffer.from(JSON.stringify({ resource: { embed: EMBED }, params: { customer: 7 }, exp: NOW + 600 })).toString("base64url")}.${s}`;
    expect(() => verifyEmbedToken(tampered, SECRET, 3600, NOW)).toThrow(/signature/);
    const none = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${token.split(".")[1]}.x`;
    expect(() => verifyEmbedToken(none, SECRET, 3600, NOW)).toThrow(/HS256/);
    expect(() => verifyEmbedToken(forge({ alg: "HS512" }, { resource: { embed: EMBED }, exp: NOW + 60 }), SECRET, 3600, NOW)).toThrow(/HS256/);
  });

  it("needs a near, future expiry", () => {
    expect(() => verifyEmbedToken(signEmbedToken(claims({ exp: NOW - 1 }), SECRET), SECRET, 3600, NOW)).toThrow(/expired/);
    expect(() => verifyEmbedToken(signEmbedToken(claims({ exp: NOW + 7200 }), SECRET), SECRET, 3600, NOW)).toThrow(/too long/);
    expect(() => verifyEmbedToken(forge({ alg: "HS256" }, { resource: { embed: EMBED } }), SECRET, 3600, NOW)).toThrow(/expiry/);
  });

  it("takes params a variable can hold - plain, a list, a { from, to } - and an instance secret", () => {
    expect(() => verifyEmbedToken(signEmbedToken(claims({ params: { x: { nested: { deeper: true } } } }), SECRET), SECRET, 3600, NOW)).toThrow(/plain value/);
    expect(() => verifyEmbedToken(signEmbedToken(claims({ params: { x: [{ a: 1 }] } }), SECRET), SECRET, 3600, NOW)).toThrow(/plain value/);
    const range = { periodo: { from: "2026-01-01", to: "2026-03-31" } };
    expect(verifyEmbedToken(signEmbedToken(claims({ params: range }), SECRET), SECRET, 3600, NOW).params).toEqual(range);
    expect(() => verifyEmbedToken("a.b.c", "", 3600, NOW)).toThrow(/not set up/);
    expect(() => verifyEmbedToken("not-a-token", SECRET, 3600, NOW)).toThrow(/malformed/);
  });

  it("preview tokens: signed with a key derived from the master key, told apart, never valid as a portal's", () => {
    const key = embedPreviewKey("master-key-for-tests");
    expect(key).not.toBe("master-key-for-tests");
    const preview = signEmbedPreviewToken({ dashboard: EMBED, display: { theme: "dark" }, variables: { customer: { mode: "LOCKED", value: "acme" } }, widget: EMBED, exp: NOW + 300 }, key);
    expect(isPreviewToken(preview)).toBe(true);
    expect(isPreviewToken(signEmbedToken(claims(), SECRET))).toBe(false);
    expect(verifyEmbedPreviewToken(preview, key, 600, NOW)).toMatchObject({ dashboard: EMBED, display: { theme: "dark" }, widget: EMBED });
    expect(() => verifyEmbedPreviewToken(preview, SECRET, 600, NOW)).toThrow(/signature/);
    expect(() => verifyEmbedToken(preview, key, 600, NOW)).toThrow(/names no embed/);
  });
});
