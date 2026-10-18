import type * as Monaco from 'monaco-editor'

// Monaco's built-in 'vs'/'vs-dark' themes hardcode their own background
// (pure black for vs-dark) instead of following the admin's actual
// surface color - defining our own theme from Nuxt UI's own CSS tokens
// (--ui-bg, --ui-border, etc.) keeps the editor's background matching the
// panel around it in both modes, light or dark. Shared by every Monaco
// instance in the admin (SqlEditor.vue, JsonViewer.vue, ...) rather than
// each one defining its own copy.
let themesDefined = false

function resolveCssVarToHex(varName: string, modeClass: 'light' | 'dark'): string {
  const container = document.createElement('div')
  container.className = modeClass
  container.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;'
  container.style.color = `var(${varName})`
  document.body.appendChild(container)
  const computed = getComputedStyle(container).color
  document.body.removeChild(container)

  // getComputedStyle().color can come back as rgb(), color(srgb ...), or
  // out-of-range channels for wide-gamut colors depending on the browser
  // (Tailwind v4 tokens are oklch()) - a 2D canvas always normalizes to
  // integer 0-255 regardless of the source color space, so painting one
  // pixel and reading it back is the reliable way to get a hex Monaco's
  // theme validator (hex-only) will accept.
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d')
  if (!ctx) return '#000000'
  ctx.fillStyle = computed
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map(v => (v ?? 0).toString(16).padStart(2, '0')).join('')}`
}

export function defineAdminThemes(m: typeof Monaco) {
  if (themesDefined) return
  themesDefined = true
  ;(['light', 'dark'] as const).forEach((mode) => {
    const bg = resolveCssVarToHex('--ui-bg', mode)
    const bgElevated = resolveCssVarToHex('--ui-bg-elevated', mode)
    const text = resolveCssVarToHex('--ui-text', mode)
    const textMuted = resolveCssVarToHex('--ui-text-muted', mode)
    const textHighlighted = resolveCssVarToHex('--ui-text-highlighted', mode)
    const border = resolveCssVarToHex('--ui-border', mode)
    const primary = resolveCssVarToHex('--ui-primary', mode)

    m.editor.defineTheme(`totalbase-${mode}`, {
      base: mode === 'dark' ? 'vs-dark' : 'vs',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': bg,
        'editor.foreground': text,
        'editorLineNumber.foreground': textMuted,
        'editorLineNumber.activeForeground': textHighlighted,
        'editor.lineHighlightBackground': bgElevated,
        'editorCursor.foreground': primary,
        'editor.selectionBackground': bgElevated,
        'editorWidget.background': bgElevated,
        'editorWidget.border': border,
        'editorIndentGuide.background1': border,
        'editorGutter.background': bg
      }
    })
  })
}

export function adminThemeName(mode: 'light' | 'dark'): string {
  return `totalbase-${mode}`
}
