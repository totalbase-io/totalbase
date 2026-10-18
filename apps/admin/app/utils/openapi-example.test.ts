import { describe, expect, it } from 'vitest'
import { curlCommand, requestBodyExample } from '~/utils/openapi-example'

const DOCUMENT = {
  paths: {
    '/api/public/table/orders': {
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', required: ['data'], properties: { data: { $ref: '#/components/schemas/OrdersCreate' } } }
            }
          }
        }
      },
      get: {}
    }
  },
  components: {
    schemas: {
      OrdersCreate: {
        type: 'object',
        required: ['customer', 'quantity', 'tags'],
        properties: {
          customer: { type: 'string', examples: ['ACME'] },
          quantity: { type: 'integer' },
          tags: { type: 'array', items: { type: 'string' } },
          note: { type: ['string', 'null'] }
        }
      }
    }
  }
}

describe('requestBodyExample()', () => {
  it('fills the required properties, following $refs and preferring the document\'s own examples', () => {
    expect(requestBodyExample(DOCUMENT, 'POST', '/api/public/table/orders')).toEqual({
      data: { customer: 'ACME', quantity: 0, tags: ['string'] }
    })
  })

  it('gives nothing for an operation without a body, or one the document doesn\'t list', () => {
    expect(requestBodyExample(DOCUMENT, 'GET', '/api/public/table/orders')).toBeUndefined()
    expect(requestBodyExample(DOCUMENT, 'DELETE', '/api/public/table/orders')).toBeUndefined()
    expect(requestBodyExample(null, 'POST', '/api/public/table/orders')).toBeUndefined()
  })
})

describe('curlCommand()', () => {
  it('adds the bearer header and a JSON body when given', () => {
    expect(curlCommand({ method: 'POST', url: 'https://x.test/api/a', authenticated: true, body: { data: { n: 'it\'s' } } })).toBe(
      'curl -X POST \'https://x.test/api/a\' \\\n'
      + '  -H \'Authorization: Bearer <token>\' \\\n'
      + '  -H \'Content-Type: application/json\' \\\n'
      + '  -d \'{\n  "data": {\n    "n": "it\'\\\'\'s"\n  }\n}\''
    )
  })

  it('leaves the token out of a public route', () => {
    expect(curlCommand({ method: 'GET', url: 'https://x.test/api/auth/me', authenticated: false })).toBe('curl -X GET \'https://x.test/api/auth/me\'')
  })
})
