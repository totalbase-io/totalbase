/**
 * Starting points for Settings > Appearance > Custom CSS (Admin_UI.md
 * §4.1.1): each one built only on the stable contract - Nuxt UI's tokens,
 * `.dark`, `html[data-surface]` and the shell's `[data-shell]` anchors - so
 * it keeps working across versions. The label is an i18n key under
 * `settings.appearance.examples.*`; the snippet is appended to the editor.
 */
export interface CustomCssExample {
  key: string
  css: string
}

export const CUSTOM_CSS_EXAMPLES: CustomCssExample[] = [
  {
    key: 'fontSize',
    css: `/* Base font size: every text scales with it (the default is 15px) */
html { font-size: 14px; }`
  },
  {
    key: 'fontFamily',
    css: `/* Typeface: a font installed on the viewer's device, or one your CSS loads with @font-face */
:root { --font-sans: 'Segoe UI', Roboto, sans-serif; }`
  },
  {
    key: 'radius',
    css: `/* Corner radius of buttons, inputs and cards (0 = square) */
:root { --ui-radius: 0.5rem; }`
  },
  {
    key: 'backgroundColors',
    css: `/* Page and panel backgrounds, light and dark */
:root { --ui-bg: #fcfcfd; --ui-bg-elevated: #f3f4f6; --ui-bg-muted: #f8f9fa; }
.dark { --ui-bg: #0f1115; --ui-bg-elevated: #181b21; --ui-bg-muted: #14161b; }`
  },
  {
    key: 'textColors',
    css: `/* Text colors: body, muted captions, headings */
:root { --ui-text: #334155; --ui-text-muted: #64748b; --ui-text-highlighted: #0f172a; }
.dark { --ui-text: #cbd5e1; --ui-text-muted: #94a3b8; --ui-text-highlighted: #ffffff; }`
  },
  {
    key: 'rail',
    css: `/* The rail (the column of group icons) in its own color */
[data-shell="rail"] { background: #0f172a; border-color: #1e293b; }
[data-shell="rail"] .action-header { border-color: #1e293b; }
[data-shell="rail"] a, [data-shell="rail"] button { color: #cbd5e1; }
[data-shell="rail"] a:hover, [data-shell="rail"] button:hover { color: #ffffff; }`
  },
  {
    key: 'panel',
    css: `/* The panel beside the rail (the active group's pages or tree) */
[data-shell="panel"] { background: #f8fafc; }
.dark [data-shell="panel"] { background: #111827; }`
  },
  {
    key: 'headers',
    css: `/* Page headers and the panel's header, with a tinted background */
.action-header, .sidebar-header { background: var(--ui-bg-muted); }`
  },
  {
    key: 'appOnly',
    css: `/* Only the App (what your users see), not the admin */
html[data-surface="app"] { --ui-primary: #0f766e; }
html[data-surface="app"] [data-shell="rail"] { background: #042f2e; }`
  },
  {
    key: 'signInOnly',
    css: `/* Only the sign-in and the other public pages */
html[data-surface="auth"] body { background: linear-gradient(160deg, #eff6ff, #ffffff); }`
  }
]
