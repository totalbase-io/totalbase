/**
 * The instance's public presentation (Specification_Admin_UI.md §4.1.1):
 * GET /api/instance once at boot, before the first page - its name, its
 * mark, the sign-in layout and the language of the pages with no user
 * (i18n-language.client.ts reads it from here). Awaited: the sign-in page
 * would otherwise paint the product's mark and then swap it.
 *
 * Safe mode: `?safe-css` on any URL drops the operator's stylesheet
 * (nuxt.config.ts's app.head link) for this load - the way out when a
 * custom rule hides the very page that edits it.
 */
export default defineNuxtPlugin({
  name: 'instance',
  async setup() {
    if (new URLSearchParams(window.location.search).has('safe-css')) {
      // The link is in the initial HTML and in unhead's state: taken out of
      // both, or unhead puts it back once it renders the head.
      injectHead().hooks?.hook('tags:resolve', (ctx) => {
        ctx.tags = ctx.tags.filter(tag => tag.props.id !== 'totalbase-theme')
      })
      document.getElementById('totalbase-theme')?.remove()
    }
    const { refresh } = useInstance()
    try {
      await refresh()
    } catch {
      // The defaults stand - the product's own look, English.
    }
  }
})
