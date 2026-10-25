// Pages a system email's link opens (invitation, password reset, email
// verification) - reached signed-out, and left alone when signed in too:
// the link belongs to whoever received the email, not the current session.
// A signed dashboard embed (Dashboards.md §9.5) is framed by
// another site for visitors with no TotalBase account: its token is its access.
const PUBLIC_PREFIXES = ['/auth/', '/embed/']
// The first-start setup (pages/setup.vue): no one can sign in yet.
const PUBLIC_PAGES = ['/setup']

export default defineNuxtRouteMiddleware((to) => {
  if (import.meta.server) return
  if (PUBLIC_PREFIXES.some(prefix => to.path.startsWith(prefix)) || PUBLIC_PAGES.includes(to.path)) return

  const session = useSession()

  const isLoginPage = to.path === '/login'

  if (!session.isAuthenticated.value && !isLoginPage) {
    return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
  }
  // `/` has no page of its own: each user's home (pages/index.vue).
  if (session.isAuthenticated.value && (isLoginPage || to.path === '/')) {
    return navigateTo(portalHomeFor(session.access.value))
  }
  // An APP user reaches the App, their account and their delegated modules
  // only - a routing decision; the server checks every request regardless.
  if (session.isAuthenticated.value && !isPortalPathAllowed(to.path, session.access.value, session.modules.value)) {
    return navigateTo(portalHomeFor(session.access.value))
  }
})
