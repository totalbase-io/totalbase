/**
 * A PDF template as the designer opens it (Administration.md §9.6): a template is written by whoever has a grant on
 * `templates`, and pdfme loads a string `basePdf`, an image's or a signature's content and anything an SVG's styles
 * point at from wherever they point - the administrator's browser fetching an address someone else chose. Anything
 * but an embedded `data:` value is dropped: a URL `basePdf` gives way to `blank`, such an image to none, an SVG that
 * reaches out (`url(`, `href`, `@import`) to none - on the pages' fields and on a blank page's fixed ones
 * (`basePdf.staticSchema`) alike.
 */
export function withoutExternalContent<T>(template: T, blank: unknown): T {
  if (!template || typeof template !== 'object') return template
  const copy = { ...(template as Record<string, unknown>) }
  if (typeof copy.basePdf === 'string' && !copy.basePdf.startsWith('data:')) copy.basePdf = blank
  else if (copy.basePdf && typeof copy.basePdf === 'object' && Array.isArray((copy.basePdf as { staticSchema?: unknown }).staticSchema)) {
    const base = copy.basePdf as { staticSchema: unknown[] }
    copy.basePdf = { ...base, staticSchema: base.staticSchema.map(cleanField) }
  }
  if (Array.isArray(copy.schemas)) {
    copy.schemas = copy.schemas.map((page: unknown) => {
      if (Array.isArray(page)) return page.map(cleanField)
      if (page && typeof page === 'object') return Object.fromEntries(Object.entries(page).map(([name, field]) => [name, cleanField(field)]))
      return page
    })
  }
  return copy as T
}

const REACHES_OUT = /url\s*\(|@import|href\s*=/i

function cleanField(field: unknown): unknown {
  const schema = field as { type?: unknown, content?: unknown } | null
  if (!schema || typeof schema.content !== 'string' || schema.content === '') return field
  const external
    = ((schema.type === 'image' || schema.type === 'signature') && !schema.content.startsWith('data:'))
      || (schema.type === 'svg' && REACHES_OUT.test(schema.content))
  return external ? { ...schema, content: '' } : field
}
