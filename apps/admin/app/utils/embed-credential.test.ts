import { describe, expect, it } from 'vitest'
import { embedCredentialFor } from './embed-credential'

const token = (claims: Record<string, unknown>) => `e30.${btoa(JSON.stringify(claims)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}.sig`
const EMBED = '7a1c4b52-9c1d-4f6e-8a2b-3c4d5e6f7a8b'
const OTHER = '0b1c4b52-9c1d-4f6e-8a2b-3c4d5e6f7a8b'

// Security regression (Dashboards.md §9.5): the page framed by one embed's sites showed whatever embed its fragment's
// credential named - another embed, restricted to other sites, could be framed through it.
describe('embedCredentialFor', () => {
  it('uses a signed token only on the page of the embed it names', () => {
    expect(embedCredentialFor(EMBED, `#${token({ resource: { embed: EMBED } })}`)).toBe(token({ resource: { embed: EMBED } }))
    expect(embedCredentialFor(EMBED, `#${token({ resource: { embed: OTHER } })}`)).toBe('')
    expect(embedCredentialFor(EMBED, '#tbe_another_link')).toBe('')
    expect(embedCredentialFor(EMBED, '#%E0%A4%A')).toBe('')
  })

  it('takes a link from its path, and the preview from its fragment', () => {
    expect(embedCredentialFor('tbe_abc', '#anything')).toBe('tbe_abc')
    expect(embedCredentialFor('preview', `#${token({ preview: true })}`)).toBe(token({ preview: true }))
  })
})
