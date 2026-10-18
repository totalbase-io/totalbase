/**
 * Reads the app's actual palette (app.config.ts's `ui.colors`, resolved by
 * Nuxt UI into `--ui-*` CSS custom properties) so ECharts uses the exact
 * same blue/slate/violet + success/warning/error hues as the rest of the
 * admin, in both light and dark mode - instead of a second, hardcoded
 * palette that can drift from app.config.ts.
 */
export function useChartTheme() {
  const colorMode = useColorMode()

  const colors = ref({
    primary: '#3b82f6',
    secondary: '#8b5cf6',
    success: '#22c55e',
    warning: '#f59e0b',
    error: '#ef4444',
    text: '#6b7280',
    textMuted: '#9ca3af',
    border: '#e5e7eb'
  })

  // The vars hold oklch() / var(...) values. ECharts can't parse those
  // when it derives a color - the hover highlight of a line or area, a
  // visualMap gradient - and draws nothing (lines vanished on hover) or
  // black. Painting one pixel on a canvas and reading it back always
  // yields plain rgb, whatever the CSS color syntax.
  const probe = import.meta.server ? null : document.createElement('canvas').getContext('2d', { willReadFrequently: true })

  function toRgb(color: string): string {
    if (!probe) return color
    probe.clearRect(0, 0, 1, 1)
    probe.fillStyle = '#000'
    probe.fillStyle = color
    probe.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data
    return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a! / 255).toFixed(3)})`
  }

  function readVar(name: string, fallback: string): string {
    // Resolved through an element so var(...) chains end in a real color.
    const holder = document.createElement('span')
    holder.style.color = `var(${name})`
    document.body.appendChild(holder)
    const value = getComputedStyle(holder).color
    holder.remove()
    return value ? toRgb(value) : fallback
  }

  function refresh() {
    if (import.meta.server) return
    colors.value = {
      primary: readVar('--ui-primary', colors.value.primary),
      secondary: readVar('--ui-secondary', colors.value.secondary),
      success: readVar('--ui-success', colors.value.success),
      warning: readVar('--ui-warning', colors.value.warning),
      error: readVar('--ui-error', colors.value.error),
      text: readVar('--ui-text-toned', colors.value.text),
      textMuted: readVar('--ui-text-muted', colors.value.textMuted),
      border: readVar('--ui-border', colors.value.border)
    }
  }

  onMounted(refresh)
  // colorMode.value flips synchronously but Nuxt UI updates the CSS vars
  // via a class/attribute change on <html> that needs a tick to apply.
  watch(() => colorMode.value, () => nextTick(refresh))

  return { colors }
}
