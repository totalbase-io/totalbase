import { appLocationFromPath, rememberAppLocation } from '~/utils/app-last-visited'

/**
 * Remembers the App object the signed-in user visits, so the App opens on it
 * next time (utils/app-last-visited.ts). A watch rather than a route
 * middleware: on a cold load straight to an object the profile arrives after
 * the route, and the visit is only recorded once both are known.
 */
export default defineNuxtPlugin({
  name: 'app-last-visited',
  dependsOn: ['session'],
  setup() {
    const route = useRoute()
    const session = useSession()
    watch([() => route.path, () => session.admin.value?.id], ([path, userId]) => {
      const location = appLocationFromPath(path)
      if (location && userId) rememberAppLocation(userId, location)
    }, { immediate: true })
  }
})
