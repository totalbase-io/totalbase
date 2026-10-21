/**
 * The operator's branding (Admin_UI.md §4.1.1): what the
 * `appearance.*` settings may hold, and the primary color's shades - shared
 * by the server (validation, /admin/theme.css) and the admin (the Appearance
 * page's preview).
 */

/** SPLIT: TotalBase's own panel (the default); SIMPLE, PANEL (the company's panel) and IMAGE: the operator's mark (M29). */
export const LOGIN_LAYOUTS = ["SPLIT", "SIMPLE", "PANEL", "IMAGE"] as const;
export type LoginLayout = (typeof LOGIN_LAYOUTS)[number];
/** Where the IMAGE layout's card sits on a wide screen (M29). */
export const LOGIN_CARD_POSITIONS = ["LEFT", "CENTER", "RIGHT"] as const;
export type LoginCardPosition = (typeof LOGIN_CARD_POSITIONS)[number];

export const CUSTOM_CSS_MAX_BYTES = 65_536;
export const LOGIN_HEADLINE_MAX = 120;
export const LOGIN_INTRO_MAX = 300;

export const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** `appearance.custom_css`: plain CSS, bounded, and never an @import (a sheet TotalBase doesn't serve). */
export function validateCustomCss(value: unknown): string | null {
  if (typeof value !== "string") return "Expected text.";
  if (new TextEncoder().encode(value).length > CUSTOM_CSS_MAX_BYTES) return `At most ${CUSTOM_CSS_MAX_BYTES / 1024} KB.`;
  if (/@import\b/i.test(value)) return "@import isn't allowed - write the rules here.";
  return null;
}

// --- The primary color's shades -------------------------------------------
//
// Nuxt UI reads eleven shades (--ui-color-primary-50…950) and uses 500 in
// light mode, 400 in dark. One hex is the color the operator means, so it
// becomes shade 500 exactly, and the others keep its hue in OKLCH on the
// lightness ladder of Tailwind's own palettes, with the chroma easing off
// toward white and black the way those palettes do. OKLCH is perceptual:
// every shade reads as "the same color, lighter or darker", which an RGB
// mix with white or black doesn't give.

const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
/** OKLCH lightness per shade (Tailwind's blue/teal/violet ladders, averaged). */
const LIGHTNESS: Record<(typeof SHADES)[number], number> = {
  50: 0.975, 100: 0.945, 200: 0.89, 300: 0.81, 400: 0.71, 500: 0.62, 600: 0.54, 700: 0.47, 800: 0.40, 900: 0.35, 950: 0.26,
};
/** Chroma relative to the color's own, per shade. */
const CHROMA: Record<(typeof SHADES)[number], number> = {
  50: 0.1, 100: 0.22, 200: 0.42, 300: 0.66, 400: 0.88, 500: 1, 600: 0.96, 700: 0.86, 800: 0.72, 900: 0.6, 950: 0.42,
};

interface Oklch {
  l: number;
  c: number;
  h: number;
}

/** sRGB hex → OKLCH (Björn Ottosson's OKLab, D65). */
export function hexToOklch(hex: string): Oklch {
  const n = Number.parseInt(hex.slice(1), 16);
  const toLinear = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = toLinear((n >> 16) & 255);
  const g = toLinear((n >> 8) & 255);
  const b = toLinear(n & 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(a, bb);
  const h = c < 1e-6 ? 0 : ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h };
}

/**
 * The eleven shades of a primary color, as `oklch()` values keyed by shade.
 * Shade 500 is the color itself; a gray (no chroma) stays gray.
 */
export function primaryShades(hex: string): Record<(typeof SHADES)[number], string> {
  const { l, c, h } = hexToOklch(hex);
  // The ladder is anchored on the color: every shade's lightness moves with
  // the color's own distance from the ladder's 500, so a dark or a pale
  // brand color keeps its ramp monotonic instead of jumping at 500.
  const shift = l - LIGHTNESS[500];
  const fmt = (v: number) => Number(v.toFixed(4));
  return Object.fromEntries(
    SHADES.map((shade) => {
      const t = shade === 500 ? 0 : shade < 500 ? (500 - shade) / 450 : (shade - 500) / 450;
      const lightness = Math.min(0.99, Math.max(0.1, LIGHTNESS[shade] + shift * (1 - t)));
      return [shade, `oklch(${fmt(lightness)} ${fmt(c * CHROMA[shade])} ${fmt(h)})`];
    }),
  ) as Record<(typeof SHADES)[number], string>;
}

/** The `:root` rule that gives Nuxt UI its primary shades - empty when there is no color. */
export function primaryColorCss(hex: string): string {
  if (!HEX_COLOR.test(hex)) return "";
  const shades = primaryShades(hex);
  return `:root {\n${SHADES.map((shade) => `  --ui-color-primary-${shade}: ${shades[shade]};`).join("\n")}\n}\n`;
}

// --- The neutral palette -------------------------------------------------
//
// Grays: text, borders, backgrounds. Tailwind's own five, by name - slate, TotalBase's bluish gray (its
// dark mode included), by default; served as --ui-color-neutral-* by /admin/theme.css, over app.config's.

export const NEUTRAL_COLORS = ["slate", "gray", "zinc", "neutral", "stone"] as const;
export type NeutralColor = (typeof NEUTRAL_COLORS)[number];

const NEUTRAL_PALETTES: Record<NeutralColor, readonly string[]> = {
  slate: ["oklch(98.4% 0.003 247.858)", "oklch(96.8% 0.007 247.896)", "oklch(92.9% 0.013 255.508)", "oklch(86.9% 0.022 252.894)", "oklch(70.4% 0.04 256.788)", "oklch(55.4% 0.046 257.417)", "oklch(44.6% 0.043 257.281)", "oklch(37.2% 0.044 257.287)", "oklch(27.9% 0.041 260.031)", "oklch(20.8% 0.042 265.755)", "oklch(12.9% 0.042 264.695)"],
  gray: ["oklch(98.5% 0.002 247.839)", "oklch(96.7% 0.003 264.542)", "oklch(92.8% 0.006 264.531)", "oklch(87.2% 0.01 258.338)", "oklch(70.7% 0.022 261.325)", "oklch(55.1% 0.027 264.364)", "oklch(44.6% 0.03 256.802)", "oklch(37.3% 0.034 259.733)", "oklch(27.8% 0.033 256.848)", "oklch(21% 0.034 264.665)", "oklch(13% 0.028 261.692)"],
  zinc: ["oklch(98.5% 0 none)", "oklch(96.7% 0.001 286.375)", "oklch(92% 0.004 286.32)", "oklch(87.1% 0.006 286.286)", "oklch(70.5% 0.015 286.067)", "oklch(55.2% 0.016 285.938)", "oklch(44.2% 0.017 285.786)", "oklch(37% 0.013 285.805)", "oklch(27.4% 0.006 286.033)", "oklch(21% 0.006 285.885)", "oklch(14.1% 0.005 285.823)"],
  neutral: ["oklch(98.5% 0 none)", "oklch(97% 0 none)", "oklch(92.2% 0 none)", "oklch(87% 0 none)", "oklch(70.8% 0 none)", "oklch(55.6% 0 none)", "oklch(43.9% 0 none)", "oklch(37.1% 0 none)", "oklch(26.9% 0 none)", "oklch(20.5% 0 none)", "oklch(14.5% 0 none)"],
  stone: ["oklch(98.5% 0.001 106.423)", "oklch(97% 0.001 106.424)", "oklch(92.3% 0.003 48.717)", "oklch(86.9% 0.005 56.366)", "oklch(70.9% 0.01 56.259)", "oklch(55.3% 0.013 58.071)", "oklch(44.4% 0.011 73.639)", "oklch(37.4% 0.01 67.558)", "oklch(26.8% 0.007 34.298)", "oklch(21.6% 0.006 56.043)", "oklch(14.7% 0.004 49.25)"],
};

/**
 * The shades of a neutral other than the default slate - "" for slate or a name it doesn't know: app.config's
 * stays. `includeDefault`: slate's too (a preview over a saved other neutral).
 */
export function neutralColorCss(name: string, includeDefault = false): string {
  if ((name === "slate" && !includeDefault) || !(NEUTRAL_COLORS as readonly string[]).includes(name)) return "";
  const shades = NEUTRAL_PALETTES[name as NeutralColor];
  return `:root {\n${SHADES.map((shade, i) => `  --ui-color-neutral-${shade}: ${shades[i]};`).join("\n")}\n}\n`;
}
