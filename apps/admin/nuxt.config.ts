// https://nuxt.com/docs/api/configuration/nuxt-config
import { DEFAULT_UI_LANGUAGE, UI_LANGUAGES } from '@totalbase/shared'
import { EAGER_LOCALE_AREAS } from './app/utils/locale-areas'

export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui',
    '@nuxtjs/i18n'
  ],

  // Admin panel, not a public site — no SEO/SSR need, and it sidesteps
  // hydration complexity for auth state (token lives in localStorage).
  ssr: false,

  // Without this, components under components/resource-detail/ auto-register
  // as e.g. `ResourceDetailTableDetail` (Nuxt's default path-based prefix)
  // instead of `TableDetail` - every template in this app uses the short
  // name, so the prefixed name is an unresolved custom element that
  // silently renders nothing. Keep the subfolder for organization, opt it
  // out of prefixing, and fall back to the default scan for everything else.
  components: [
    { path: '~/components/resource-detail', pathPrefix: false },
    '~/components'
  ],

  devtools: {
    enabled: true
  },

  // apps/server serves the built output of this app under /admin/, from
  // the same process/port as the API (Specification_Admin_UI.md §1.1, "one service") — every asset
  // and client-side route has to be generated relative to that prefix, in
  // dev too, so dev behavior actually matches what gets deployed rather
  // than only matching once base path bugs are found in prod.
  app: {
    baseURL: '/admin/',
    // The operator's stylesheet (Specification_Admin_UI.md §4.1.1): the
    // primary color and the custom CSS, served by apps/server from the
    // appearance.* settings. Linked here, in <head>, so it applies before
    // Vue mounts - no flash of the default look - and on the pages with no
    // user. plugins/instance.client.ts drops it on `?safe-css`.
    head: {
      // tagPriority low: after the app's own stylesheets, so a rule of the operator's wins on order too.
      link: [
        { rel: 'stylesheet', href: '/admin/theme.css', id: 'totalbase-theme', tagPriority: 'low' },
        { rel: 'icon', href: '/admin/favicon.ico', sizes: '16x16 32x32 48x48' },
        { rel: 'icon', href: '/admin/logo.svg', type: 'image/svg+xml' }
      ]
    }
  },

  css: ['~/assets/css/main.css'],

  compatibilityDate: '2026-06-30',

  // Dev-only: forwards Admin API calls to the running apps/server so the UI
  // can call same-origin relative paths (`/admin/api/...`) in both dev and
  // prod. In prod, apps/server serves this app's static build under `/admin/`
  // itself, so no proxy is needed there — see Specification_Admin_UI.md §1.1.
  //
  // `/api` (root, no `/admin` prefix) is the *public* REST Data API
  // (useDataApi.ts) - a DataView's grid/Edit form call this directly, same
  // as prod where apps/server answers both prefixes on one origin. Without
  // this second rule, Vite's own dev server (base: '/admin/') 302-redirects
  // any request outside that base into it *before* the proxy even runs -
  // `/api/...` becomes `/admin/api/...`, which the rule above then forwards
  // to a route that doesn't exist there (that prefix is admin-management
  // only). A dedicated rule for the bare `/api` prefix intercepts first,
  // so the request reaches apps/server at the exact path it actually
  // registers the public Data API on. `/app/api` (the App's own routes -
  // its menu, published DataViews/Dashboards, My account) needs the same
  // rule for the same reason.
  vite: {
    server: {
      proxy: {
        '/admin/api': {
          target: process.env.TOTALBASE_API_PROXY_TARGET ?? 'http://localhost:3050',
          changeOrigin: true
        },
        '/api': {
          target: process.env.TOTALBASE_API_PROXY_TARGET ?? 'http://localhost:3050',
          changeOrigin: true
        },
        '/app/api': {
          target: process.env.TOTALBASE_API_PROXY_TARGET ?? 'http://localhost:3050',
          changeOrigin: true
        },
        // The operator's stylesheet (app.head above) - apps/server's, not a built asset.
        '/admin/theme.css': {
          target: process.env.TOTALBASE_API_PROXY_TARGET ?? 'http://localhost:3050',
          changeOrigin: true
        }
      }
    }
  },

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  },

  // The UI's language (Specification_Admin_UI.md §14): English by default
  // and as the source, one file per area and language in i18n/locales/
  // (each with its own top-level keys - the areas' texts are kept,
  // translated and reviewed apart). Only the eager areas are registered
  // here - the module loads a locale's files all together, with the app;
  // the editor and administration areas load per route
  // (utils/locale-areas.ts, plugins/i18n-areas.client.ts). No URL prefix
  // and no browser detection - the language is the signed-in user's
  // preference, else the instance's (plugins/i18n-language.client.ts).
  // The list of languages is @totalbase/shared's, the one the server
  // validates with.
  i18n: {
    strategy: 'no_prefix',
    defaultLocale: DEFAULT_UI_LANGUAGE,
    locales: UI_LANGUAGES.map(language => ({ code: language.code, language: language.bcp47, name: language.name, files: EAGER_LOCALE_AREAS.map(area => `${language.code}/${area}.json`) })),
    detectBrowserLanguage: false,
    // Help texts name placeholders like `$VAR.<name>` or `record.data.<column>`: rendered as text (never v-html),
    // so the "detected HTML" check would only reject them - and with them a whole area's file.
    compilation: { strictMessage: false }
  },

  // Icons: the ones the source names literally (`i-lucide-…`, .ts too -
  // the default globs leave it out) ship in the client bundle; the rest -
  // icons a user picks for a DataView, a Dashboard, a menu group - come
  // from apps/server's /admin/_icons (admin-icons.ts), in the Iconify API's
  // format. Never api.iconify.design (`fallbackToApi: false`): works
  // offline, and no third party learns what an instance uses. Nuxt Icon's
  // own endpoint can't serve them - it would sit under /admin/api (the
  // Admin API's prefix), and the production build is static, with no Nuxt
  // server. The icon picker's full catalog (utils/lucide-icon-names.ts)
  // stays out of the scan: bundling all ~1,850 icons for a picker most
  // sessions never open.
  icon: {
    provider: 'server',
    localApiEndpoint: '/_icons',
    fallbackToApi: false,
    clientBundle: {
      scan: {
        globInclude: ['**/*.{vue,ts}'],
        globExclude: ['node_modules', 'dist', 'build', 'coverage', 'test', 'tests', '.*', '**/lucide-icon-names.ts']
      }
    }
  }
})
