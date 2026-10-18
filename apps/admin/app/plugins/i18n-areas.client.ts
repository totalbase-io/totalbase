import { LAZY_LOCALE_AREAS, lazyAreaOfKey, type LazyLocaleArea } from '~/utils/locale-areas'

/**
 * The lazy locale areas (utils/locale-areas.ts): loads an area's file for
 * a language the first time a route needs it and merges it into vue-i18n -
 * @nuxtjs/i18n itself loads a locale's files all together, so the eager
 * areas are the only ones it knows (nuxt.config.ts). Three ways in:
 *
 * - `$localeAreas.ensure(areas)` - awaited by the route middleware before
 *   a page renders, so its texts are there at the first paint;
 * - a language switch (`i18n:beforeLocaleSwitch`, awaited by the module
 *   before it switches) loads every area visited so far in the new
 *   language first - and a watch on the locale catches a switch that
 *   started before this plugin's first `ensure` (the signed-in user's
 *   language applies at boot, unawaited);
 * - a missing key of a lazy area (a shared component shown on a route the
 *   map doesn't list) loads that area then - the key shows for one paint.
 *
 * The files are imported as JSON and compiled by vue-i18n on first use
 * (the module bundles the compiler: `bundle.runtimeOnly` is off); each is
 * its own chunk, fetched once per language.
 */

/** Every area file, by `<language>/<area>` - a chunk each, loaded on demand. */
const AREA_FILES = import.meta.glob<Record<string, unknown>>('../../i18n/locales/*/*.json', { import: 'default' })

export default defineNuxtPlugin({
  name: 'i18n-areas',
  dependsOn: ['i18n:plugin'],
  setup(nuxtApp) {
    const i18n = nuxtApp.$i18n as {
      locale: Ref<string>
      mergeLocaleMessage: (locale: string, messages: Record<string, unknown>) => void
      setMissingHandler: (handler: (locale: string, key: string) => void) => void
    }
    /** `<language>/<area>` loaded or loading - one request per pair, however many ask. */
    const loads = new Map<string, Promise<void>>()
    /** The areas any route or key asked for - what a new language loads before switching. */
    const visited = new Set<LazyLocaleArea>()

    function load(language: string, area: LazyLocaleArea): Promise<void> {
      const key = `${language}/${area}`
      let pending = loads.get(key)
      if (!pending) {
        const file = AREA_FILES[`../../i18n/locales/${key}.json`]
        pending = file
          ? file().then((messages) => {
              i18n.mergeLocaleMessage(language, messages)
            })
          : Promise.resolve()
        pending.catch(() => loads.delete(key)) // a failed fetch (offline) is retried on the next ask.
        loads.set(key, pending)
      }
      return pending
    }

    function ensure(areas: readonly LazyLocaleArea[], language = i18n.locale.value): Promise<void> {
      for (const area of areas) visited.add(area)
      return Promise.all(areas.map(area => load(language, area))).then(() => undefined)
    }

    nuxtApp.hook('i18n:beforeLocaleSwitch', async ({ newLocale }) => {
      await ensure([...visited], newLocale)
    })
    watch(i18n.locale, language => void ensure([...visited], language))

    i18n.setMissingHandler((language, key) => {
      const area = lazyAreaOfKey(key)
      if (!area) return
      // `language` is the one the lookup failed in - the current one, or a fallback's; the current one gets it too.
      if (!loads.has(`${language}/${area}`)) void ensure([area], language)
      if (language !== i18n.locale.value) void ensure([area])
    })

    return { provide: { localeAreas: { ensure, areas: LAZY_LOCALE_AREAS } } }
  }
})
