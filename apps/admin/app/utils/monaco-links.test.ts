import { describe, expect, it } from 'vitest'
import { isOpenableLink } from './monaco-links'

// Security regression (Admin_UI.md §1.1): Monaco opened any link on Ctrl+click - a `javascript:` URL in a stored text
// file ran on the admin's origin when an administrator opened the file.
describe('isOpenableLink', () => {
  it('opens web addresses only', () => {
    expect(isOpenableLink('https://example.com/a')).toBe(true)
    expect(isOpenableLink('HTTP://example.com')).toBe(true)
    for (const href of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'file:///etc/passwd', 'vbscript:x', '//example.com']) {
      expect(isOpenableLink(href), href).toBe(false)
    }
  })
})
