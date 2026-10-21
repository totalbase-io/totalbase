type Schema = Record<string, unknown>

/** The bits of a generated OpenAPI document an example is read from. */
export interface OpenApiDocumentLike {
  paths?: Record<string, Record<string, { requestBody?: { content?: Record<string, { schema?: Schema }> } }>>
  components?: { schemas?: Record<string, Schema> }
}

const MAX_DEPTH = 6

/**
 * A sample value for `schema`: its own `examples`/`default` when the
 * document has one (openapi.include_examples), else a placeholder by type.
 * Only required properties of an object are filled in - the smallest body
 * the endpoint would accept, not every optional column.
 */
function sample(schema: Schema | undefined, document: OpenApiDocumentLike, depth = 0): unknown {
  if (!schema || depth > MAX_DEPTH) return undefined
  const ref = schema.$ref
  if (typeof ref === 'string') {
    return sample(document.components?.schemas?.[ref.replace('#/components/schemas/', '')], document, depth + 1)
  }
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0]
  if (schema.default !== undefined) return schema.default
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]
  for (const key of ['oneOf', 'anyOf'] as const) {
    const options = schema[key]
    if (Array.isArray(options) && options.length > 0) return sample(options[0] as Schema, document, depth + 1)
  }

  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  const type = types.find(t => t !== 'null') ?? (schema.properties ? 'object' : undefined)
  switch (type) {
    case 'object': {
      const properties = (schema.properties ?? {}) as Record<string, Schema>
      const required = Array.isArray(schema.required) ? schema.required as string[] : []
      return Object.fromEntries(required.filter(name => name in properties).map(name => [name, sample(properties[name], document, depth + 1)]))
    }
    case 'array': {
      const item = sample(schema.items as Schema | undefined, document, depth + 1)
      return item === undefined ? [] : [item]
    }
    case 'integer':
    case 'number':
      return 0
    case 'boolean':
      return false
    case 'string':
      return schema.format === 'uuid'
        ? '00000000-0000-0000-0000-000000000000'
        : schema.format === 'date-time' ? '2026-01-01T00:00:00Z' : schema.format === 'date' ? '2026-01-01' : 'string'
    default:
      return null
  }
}

/** The JSON body to send to `method path`, or undefined when the document gives it none. */
export function requestBodyExample(document: OpenApiDocumentLike | null | undefined, method: string, path: string): unknown {
  const operation = document?.paths?.[path]?.[method.toLowerCase()]
  const schema = operation?.requestBody?.content?.['application/json']?.schema
  return schema ? sample(schema, document!) : undefined
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/** A copy-pasteable cURL command (Admin_UI.md §12). */
export function curlCommand(input: { method: string, url: string, authenticated: boolean, body?: unknown }): string {
  const lines = [`curl -X ${input.method} ${quote(input.url)}`]
  if (input.authenticated) lines.push(`-H 'Authorization: Bearer <token>'`)
  if (input.body !== undefined) {
    lines.push(`-H 'Content-Type: application/json'`)
    lines.push(`-d ${quote(JSON.stringify(input.body, null, 2))}`)
  }
  return lines.join(' \\\n  ')
}
