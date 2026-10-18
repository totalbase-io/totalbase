/**
 * Each admin screen's documentation page (Specification_Admin_UI.md §3.8) - the docs mirror the admin, a page
 * per screen (AGENTS.md section 1), so a screen's "?" opens the page about it. One list, matched in order
 * against the router's path (the admin's base left out); a screen with no entry shows no "?". The App's pages
 * are for its users, not administrators, and have none.
 */
export const DOCS_BASE_URL = 'https://docs.totalbase.io'

const DOCS_PAGES: [RegExp, string][] = [
  [/^\/status$/, '/getting-started/admin-tour'],
  [/^\/database\/sql-console$|^\/sql-console$/, '/sql-console/overview'],
  [/^\/database\/tables\//, '/database/tables'],
  [/^\/database\/views\//, '/database/views'],
  [/^\/database\/functions\//, '/database/functions'],
  [/^\/database(\/|$)|^\/resources(\/|$)/, '/concepts/resources'],
  [/^\/dataviews\/[^/]+\/design$/, '/dataviews/design-form/overview'],
  [/^\/dataviews\/[^/]+\/settings$/, '/dataviews/settings/general'],
  [/^\/dataviews(\/|$)/, '/dataviews/overview'],
  [/^\/dashboards\/[^/]+\/settings$/, '/dashboards/settings/general'],
  [/^\/dashboards\/[^/]+$/, '/dashboards/editor'],
  [/^\/dashboards(\/|$)/, '/dashboards/overview'],
  [/^\/workflows\/[^/]+\/settings$/, '/workflows/settings/general'],
  [/^\/workflows\/[^/]+$/, '/workflows/editor'],
  [/^\/workflows(\/|$)/, '/workflows/overview'],
  [/^\/files$/, '/files/overview'],
  [/^\/templates\/system\//, '/templates/system-emails'],
  [/^\/templates(\/|$)/, '/templates/overview'],
  [/^\/users\/insights\/sign-ins$/, '/users/insights/sign-ins'],
  [/^\/users\/insights\/activity$/, '/users/insights/activity'],
  [/^\/users\/[^/]+$/, '/users/a-users-page'],
  [/^\/users$/, '/users/managing-users'],
  [/^\/tokens$/, '/users/api-tokens'],
  [/^\/sessions$/, '/users/sessions'],
  [/^\/roles(\/|$)/, '/roles/creating-a-role'],
  [/^\/logs$/, '/logs/audit-log'],
  [/^\/docs\//, '/data-api/openapi'],
  [/^\/account$/, '/user-profile/my-account'],
  [/^\/settings\/system$/, '/settings/general#general'],
  [/^\/settings\/appearance$/, '/settings/general#appearance'],
  [/^\/settings\/connector$/, '/settings/general#connector'],
  [/^\/settings\/maintenance$/, '/settings/general#maintenance'],
  [/^\/settings\/smtp$/, '/settings/general#smtp'],
  [/^\/settings\/auth$/, '/settings/access#authentication'],
  [/^\/settings\/auth-providers$/, '/settings/access#providers'],
  [/^\/settings\/api-tokens$/, '/settings/access#tokens'],
  [/^\/settings\/network$/, '/settings/security#network'],
  [/^\/settings\/secrets$/, '/settings/security#secrets'],
  [/^\/settings\/audit$/, '/settings/security#audit'],
  [/^\/settings\/api$/, '/settings/data-api#limits'],
  [/^\/settings\/transactions$/, '/settings/data-api#transactions'],
  [/^\/settings\/async-executions$/, '/settings/data-api#executions'],
  [/^\/settings\/openapi$/, '/settings/data-api#openapi'],
  [/^\/settings\/mcp$/, '/settings/data-api#mcp'],
  [/^\/settings\/dataviews$/, '/settings/features#dataviews'],
  [/^\/settings\/dashboards$/, '/settings/features#dashboards'],
  [/^\/settings\/maps$/, '/settings/features#maps'],
  [/^\/settings\/files$/, '/settings/features#files'],
  [/^\/settings\/workflows$/, '/settings/features#workflows'],
  [/^\/settings\/sql-console$/, '/settings/features#sql-console']
]

/** The documentation page about the screen at `path`, or null. */
export function docsLinkFor(path: string): string | null {
  const page = DOCS_PAGES.find(([pattern]) => pattern.test(path))?.[1]
  return page ? `${DOCS_BASE_URL}${page}` : null
}

/** Every page the list points at - its test checks each one exists in docs/content. */
export const DOCS_LINKED_PAGES = DOCS_PAGES.map(([, page]) => page.split('#')[0]!)
