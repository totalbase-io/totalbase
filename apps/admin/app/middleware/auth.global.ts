// Pages a system email's link opens (invitation, password reset, email
// verification) - reached signed-out, and left alone when signed in too:
// the link belongs to whoever received the email, not the current session.
// A signed dashboard embed (Dashboards.md §9.5) is framed by
// another site for visitors with no TotalBase account: its token is its access.
const PUBLIC_PREFIXES = ['/auth/', '/embed/']
// The first-start setup (pages/setup.vue): no one can sign in yet.
// /lockdown: where a signed-in user who isn't an administrator waits out a lockdown (Security.md §2.21).
const PUBLIC_PAGES = ['/setup', '/lockdown']

export default defineNuxtRouteMiddleware((to) => {
  if (import.meta.server) return
  if (PUBLIC_PREFIXES.some(prefix => to.path.startsWith(prefix)) || PUBLIC_PAGES.includes(to.path)) return

  const session = useSession()

  const isLoginPage = to.path === '/login'

  if (!session.isAuthenticated.value && !isLoginPage) {
    // A session a lockdown keeps out (plugins/session.client.ts): its user waits, still signed in - the sign-in
    // page stays one click away, for an administrator on the same browser.
    if (useLockedOut().value) return navigateTo('/lockdown')
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
