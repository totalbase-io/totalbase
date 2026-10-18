import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DOCS_LINKED_PAGES, docsLinkFor } from '~/utils/docs-links'

/** The docs' route of each page: its path in docs/content with the order prefixes and `.md` left out. */
function docsRoutes(dir: string, base = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const name = entry.name.replace(/^\d+\./, '').replace(/\.md$/, '')
    return entry.isDirectory() ? docsRoutes(join(dir, entry.name), `${base}/${name}`) : [`${base}/${name}`]
  })
}

describe('a screen\'s documentation link', () => {
  const content = new URL('../../../../docs/content', import.meta.url).pathname

  it('points every screen at a page that exists', () => {
    expect(existsSync(content)).toBe(true)
    const routes = new Set(docsRoutes(content))
    expect(DOCS_LINKED_PAGES.filter(page => !routes.has(page))).toEqual([])
  })

  it('matches the most specific screen first, and nothing for the App', () => {
    expect(docsLinkFor('/dataviews/abc/settings')).toBe('https://docs.totalbase.io/dataviews/settings/general')
    expect(docsLinkFor('/dataviews')).toBe('https://docs.totalbase.io/dataviews/overview')
    expect(docsLinkFor('/settings/smtp')).toBe('https://docs.totalbase.io/settings/general#smtp')
    expect(docsLinkFor('/app/dataviews/orders')).toBeNull()
  })
})
