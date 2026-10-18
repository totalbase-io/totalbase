/**
 * Ready-made themes for Settings > Appearance (Specification_Admin_UI.md
 * §4.1.1): each one a complete custom CSS built on the stable contract only
 * (`[data-shell]`, Nuxt UI's tokens, `.dark`), chosen from a thumbnail.
 * Applying one replaces the sheet with its CSS, headed by a `Theme: <key>` comment
 * - which is also how the page tells which theme is on - and the sheet stays
 * editable from there. Not a theme generator: a theme is a named CSS.
 */
export interface CssTheme {
  key: string
  /** Colors the thumbnail is drawn with: the rail, the panel, the content area (light mode). */
  swatch: { rail: string, panel: string, content: string, railText: string }
  css: string
}

const THEME_HEADER = /^\/\* Theme: ([a-z-]+) \*\//

/** The theme a sheet was made from, or null (empty, an example, hand-written). */
export function themeOf(css: string): string | null {
  const match = THEME_HEADER.exec(css.trimStart())
  return match ? match[1]! : null
}

export function themeCss(theme: CssTheme): string {
  return `/* Theme: ${theme.key} */\n${theme.css.trim()}\n`
}

function railTheme(key: string, rail: string, railBorder: string, railText: string, railTextHover: string, panel: string, panelDark: string, content: string, contentDark: string): CssTheme {
  return {
    key,
    swatch: { rail, panel, content, railText },
    css: `
[data-shell="rail"] { background: ${rail}; border-color: ${railBorder}; }
[data-shell="rail"] .action-header { border-color: ${railBorder}; }
[data-shell="rail"] a, [data-shell="rail"] button { color: ${railText}; }
[data-shell="rail"] a:hover, [data-shell="rail"] button:hover { color: ${railTextHover}; }
[data-shell="panel"] { background: ${panel}; }
[data-shell="main"] { background: ${content}; }
.dark [data-shell="panel"] { background: ${panelDark}; }
.dark [data-shell="main"] { background: ${contentDark}; }`
  }
}

export const CSS_THEMES: CssTheme[] = [
  // The product's own look - no CSS at all.
  { key: 'default', swatch: { rail: '#ffffff', panel: '#ffffff', content: '#f8fafc', railText: '#2563eb' }, css: '' },
  railTheme('navy', '#0f172a', '#1e293b', '#cbd5e1', '#ffffff', '#f8fafc', '#111827', '#ffffff', '#0b0f17'),
  railTheme('slate', '#334155', '#475569', '#e2e8f0', '#ffffff', '#f1f5f9', '#1e293b', '#ffffff', '#0f172a'),
  railTheme('graphite', '#18181b', '#27272a', '#d4d4d8', '#ffffff', '#fafafa', '#18181b', '#ffffff', '#09090b'),
  railTheme('forest', '#064e3b', '#065f46', '#a7f3d0', '#ffffff', '#f0fdf4', '#052e16', '#ffffff', '#031a0d'),
  railTheme('ocean', '#0c4a6e', '#075985', '#bae6fd', '#ffffff', '#f0f9ff', '#082f49', '#ffffff', '#04192a'),
  railTheme('plum', '#3b0764', '#4c1d95', '#ddd6fe', '#ffffff', '#faf5ff', '#2e1065', '#ffffff', '#160530'),
  // Light everywhere, white content - the rail and the panel in a soft gray.
  {
    key: 'paper',
    swatch: { rail: '#f4f4f5', panel: '#fafafa', content: '#ffffff', railText: '#52525b' },
    css: `
[data-shell="rail"] { background: #f4f4f5; }
[data-shell="panel"] { background: #fafafa; }
[data-shell="main"] { background: #ffffff; }
.dark [data-shell="rail"] { background: #18181b; }
.dark [data-shell="panel"] { background: #111113; }
.dark [data-shell="main"] { background: #09090b; }`
  }
]
