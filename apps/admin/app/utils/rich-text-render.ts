import { roleColorShade } from '~/types/permission'
import type { FormulaRichSegment } from '~/utils/formula-engine'

/**
 * `FormulaRichSegment[]` (formula-engine.ts's own doc comment on why a
 * formula's rich result is a segment list, not a string) -> a small,
 * SAFE HTML string - the one place this app builds real markup out of a
 * formula's result. Safe because the only tags that can ever appear
 * here are the fixed ones below (`<b>`/`<i>`/`<u>`/`<s>`/`<span>`/`<a>`/
 * `<br>`/`<svg>`), never anything the formula author or a column's own
 * value chose - EVERY segment's own `text` still goes through
 * `escapeHtml` exactly like the plain (non-rich) render path already
 * does, so a malicious column value (`<img onerror=...>`) is still
 * inert content, never markup, regardless of which segment it landed
 * in. `icon` is a closed `LUCIDE_ICON_NAMES` token (formula-engine.ts's
 * own `ICON()` validation) - the actual glyph is fetched on demand
 * (`fetchLucideIconSvg` below), never a raw string either.
 *
 * Async (unlike a plain string builder) ONLY because of `icon` - text/
 * bold/color/badge/link all resolve synchronously; awaiting is a no-op
 * for a segment list with no `ICON()` in it at all (the common case).
 *
 * `mode` defaults to 'light' - the one real consumer so far (the Map
 * popup, `DataViewMap.vue`) is a plain white Leaflet popup regardless
 * of the app's own dark/light setting (same simplification its own pin
 * tinting already makes, see `pinSvg`'s own `roleColorShade(color,
 * 'light')` call) - pass 'dark' explicitly for a consumer that actually
 * sits on a dark surface.
 */
export async function renderRichTextHtml(segments: FormulaRichSegment[], mode: 'light' | 'dark' = 'light'): Promise<string> {
  const iconNames = [...new Set(segments.map(s => s.icon).filter((v): v is string => !!v))]
  const icons = new Map(await Promise.all(iconNames.map(async name => [name, await fetchLucideIconSvg(name)] as const)))
  return segments.map(segment => renderSegment(segment, mode, icons)).join('')
}

function renderSegment(segment: FormulaRichSegment, mode: 'light' | 'dark', icons: Map<string, string | null>): string {
  if (segment.break) return '<br>'
  if (segment.icon) return icons.get(segment.icon) ?? ''
  let html = escapeHtml(segment.text)
  if (segment.link) {
    const targetAttr = segment.link.target === '_self' ? '' : ` target="${escapeHtml(segment.link.target)}" rel="noopener noreferrer"`
    html = `<a href="${escapeHtml(segment.link.url)}"${targetAttr}>${html}</a>`
  }
  if (segment.badge) {
    const color = roleColorShade(segment.badge, mode)
    html = `<span style="display:inline-block;padding:1px 8px;border-radius:9999px;font-size:0.7em;font-weight:600;color:${contrastTextColor(color)};background-color:${color};">${html}</span>`
  } else if (segment.color) {
    html = `<span style="color:${roleColorShade(segment.color, mode)};">${html}</span>`
  }
  if (segment.bold) html = `<b>${html}</b>`
  if (segment.italic) html = `<i>${html}</i>`
  if (segment.underline) html = `<u>${html}</u>`
  if (segment.strikethrough) html = `<s>${html}</s>`
  return html
}

/** Same escaping rule `DataViewMap.vue`'s own (now superseded, for rich results) `escapeHtml` already used - kept private here rather than importing that component's, so this file has no dependency on the Map at all (Card layout's own description will want the exact same function once it gets rich support too, per this file's own future-consumer note above). */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c]!)
}

/**
 * BADGE's own text color, computed from the badge's actual background
 * rather than a hardcoded `white` (a real bug report - amber/yellow/
 * lime/etc's light shades made white text nearly unreadable, see the
 * chat's own screenshot). `roleColorShade`'s own colors are already
 * oklch (types/permission.ts's `ROLE_COLOR_SHADES` doc comment) - oklch's
 * first component IS perceptual lightness (0-100%), so reading it
 * straight out of that string is a real, cheap, framework-free contrast
 * check, not a rough approximation dressed up as one. Not a full WCAG
 * contrast-ratio computation (which would also need the TEXT color's own
 * luminance, not just the background's) - a simple L-based threshold is
 * plenty for a solid two-color chip like this, same "pragmatic over
 * exhaustive" calls this app makes elsewhere.
 */
function contrastTextColor(oklch: string): 'white' | 'black' {
  const lightness = Number(/oklch\(([\d.]+)%/.exec(oklch)?.[1] ?? 50)
  return lightness > 68 ? 'black' : 'white'
}

/**
 * ONE icon's raw SVG - a lazy `import()` of `@iconify-json/lucide`'s own
 * icons.json (the whole Lucide set, ~500KB), NOT Nuxt Icon's local
 * server API route (`/api/_nuxt_icon/:collection`) - that route is
 * UNREACHABLE in this project: `nuxt.config.ts`'s dev proxy forwards
 * EVERY `/api/*` and `/admin/api/*` request straight to `apps/server`
 * (confirmed live - both paths 401/404 there, Nitro's own icon handler
 * never runs), and in production this app is `ssr: false`, deployed as
 * a static SPA build with no live Nuxt/Nitro process at all to answer a
 * dynamic route in the first place (a first attempt at this used that
 * route and silently never showed a glyph, in dev OR prod, for exactly
 * that reason - a dead end worth remembering: this app has no
 * server-side rendering surface to lean on for anything).
 *
 * A dynamic `import()` (not a static one at the top of this file) keeps
 * that ~500KB out of every bundle that merely imports this module for
 * its text/bold/color/badge/link rendering (the common case, no
 * `ICON()` involved) - it only downloads the first time a formula
 * actually resolves to an icon segment, as its own separate chunk
 * (Vite's own code-splitting), and `iconSetPromise` below caches that
 * one load for the rest of the session - every icon lookup after the
 * first is a synchronous dictionary read against the already-loaded set.
 */
const LUCIDE_PREFIX = 'i-lucide-'
interface LucideIconEntry { body: string, width?: number, height?: number }
interface LucideIconSet { icons: Record<string, LucideIconEntry>, aliases?: Record<string, { parent: string }>, width: number, height: number }
let iconSetPromise: Promise<LucideIconSet> | null = null
function loadLucideIconSet(): Promise<LucideIconSet> {
  if (!iconSetPromise) {
    iconSetPromise = import('@iconify-json/lucide/icons.json').then(m => (m as unknown as { default: LucideIconSet }).default ?? (m as unknown as LucideIconSet))
  }
  return iconSetPromise
}
const iconCache = new Map<string, string | null>()
async function fetchLucideIconSvg(name: string): Promise<string | null> {
  const bareName = name.startsWith(LUCIDE_PREFIX) ? name.slice(LUCIDE_PREFIX.length) : name
  if (iconCache.has(bareName)) return iconCache.get(bareName)!
  const set = await loadLucideIconSet()
  // A handful of Lucide names are aliases (a renamed/deprecated icon
  // pointing at another entry's own body) rather than a direct `icons`
  // key - `LUCIDE_ICON_NAMES` doesn't distinguish the two, so this has
  // to check both to avoid a silently-missing glyph for those names.
  const entry = set.icons[bareName] ?? (set.aliases?.[bareName] ? set.icons[set.aliases[bareName].parent] : undefined)
  const result = entry
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 ${entry.width ?? set.width} ${entry.height ?? set.height}" style="vertical-align:-0.15em;">${entry.body}</svg>`
    : null
  iconCache.set(bareName, result)
  return result
}
