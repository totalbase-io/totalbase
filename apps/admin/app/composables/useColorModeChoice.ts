/**
 * The color mode (Admin_UI.md §4.1): the instance's (`appearance.color_mode`, read from /api/instance) until the
 * viewer picks one of their own in the avatar menu - kept in this browser, and it always wins. Its own key, apart
 * from @nuxtjs/color-mode's: that one holds whatever was last applied, the instance's included, so it can't tell
 * "picked" from "followed". `midnight` is a mode of its own: <html class="midnight">, the content light, the rail
 * and the panel dark (layouts/default.vue, ShellSurface.vue).
 */
export type ColorModeChoice = 'system' | 'light' | 'dark' | 'midnight'

const STORAGE_KEY = 'totalbase-color-mode'
const CHOICES: readonly ColorModeChoice[] = ['system', 'light', 'dark', 'midnight']

function readChoice(): ColorModeChoice | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return CHOICES.includes(stored as ColorModeChoice) ? stored as ColorModeChoice : null
  } catch {
    return null
  }
}

export function useColorModeChoice() {
  const colorMode = useColorMode()
  const { instance } = useInstance()
  /** The viewer's own pick, or null - the instance's then. */
  const choice = useState<ColorModeChoice | null>('color-mode-choice', readChoice)

  function apply() {
    colorMode.preference = choice.value ?? instance.value.colorMode.toLowerCase()
  }
  function choose(next: ColorModeChoice | null) {
    choice.value = next
    try {
      if (next) window.localStorage.setItem(STORAGE_KEY, next)
      else window.localStorage.removeItem(STORAGE_KEY)
    } catch {
      // This load still shows it; the next one follows the instance.
    }
    apply()
  }
  return { choice, choose, apply }
}
