import { describe, expect, it } from 'vitest'
import { withoutExternalContent } from './pdf-template-safe'

// Security regression (Administration.md §9.6): a template written through a Data API grant could point its basePdf or
// an image at any address, which pdfme fetched from the administrator's browser when the designer opened it.
describe('withoutExternalContent', () => {
  it('keeps embedded content and drops what points elsewhere', () => {
    const blank = { width: 210, height: 297, padding: [10, 10, 10, 10] }
    const template = {
      basePdf: 'https://tracker.example/base.pdf',
      schemas: [[
        { name: 'logo', type: 'image', content: 'https://tracker.example/pixel.png' },
        { name: 'stamp', type: 'image', content: 'data:image/png;base64,AAAA' },
        { name: 'sign', type: 'signature', content: '//tracker.example/s.png' },
        { name: 'title', type: 'text', content: 'https://example.com is just text' }
      ]]
    }
    const safe = withoutExternalContent(template, blank)
    expect(safe.basePdf).toEqual(blank)
    expect(safe.schemas[0]!.map(field => field.content)).toEqual(['', 'data:image/png;base64,AAAA', '', 'https://example.com is just text'])
    expect(withoutExternalContent({ basePdf: 'data:application/pdf;base64,AAAA', schemas: [] }, blank).basePdf).toBe('data:application/pdf;base64,AAAA')
  })

  // SEC-86: a blank page's fixed fields (staticSchema) and an SVG's style url() still fetched.
  it('cleans a blank page\'s fixed fields and an SVG that reaches out', () => {
    const blank = { width: 210, height: 297, padding: [0, 0, 0, 0] }
    const template = {
      basePdf: { ...blank, staticSchema: [{ name: 'header', type: 'image', content: 'https://tracker.example/h.png' }] },
      schemas: [[
        { name: 'art', type: 'svg', content: '<svg xmlns="http://www.w3.org/2000/svg" style="background-image:url(https://tracker.example/b)"/>' },
        { name: 'plain', type: 'svg', content: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>' }
      ]]
    }
    const safe = withoutExternalContent(template, blank)
    expect(safe.basePdf.staticSchema[0]!.content).toBe('')
    expect(safe.schemas[0]!.map(field => field.content)).toEqual(['', template.schemas[0]![1]!.content])
  })
})
