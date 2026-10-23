import { localeAreasForRoute } from '~/utils/locale-areas'

/**
 * The lazy locale areas a route needs (utils/locale-areas.ts), loaded
 * before its page renders - awaited, so the page's first paint has its
 * texts rather than their keys. Loaded once per language; a route whose
 * areas are there already costs nothing (plugins/i18n-areas.client.ts).
 */
export default defineNuxtRouteMiddleware(async (to) => {
  if (import.meta.server) return
  // A language switch under way (a sign-in in another language) first: its
  // files, and the areas loaded in it, rather than the old language's.
  await useNuxtApp().$uiLanguage.settled()
  const areas = localeAreasForRoute(to.path)
  if (areas.length > 0) await useNuxtApp().$localeAreas.ensure(areas)
})
