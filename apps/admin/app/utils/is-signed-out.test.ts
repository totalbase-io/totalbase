import { describe, expect, it } from 'vitest'
import { isSignedOut } from './api-request'

describe('isSignedOut()', () => {
  it('is the server saying the session is gone - never a transient failure', () => {
    expect(isSignedOut({ status: 401 })).toBe(true)
    expect(isSignedOut({ statusCode: 403 })).toBe(true)
    for (const status of [429, 500, 502, 503]) expect(isSignedOut({ status })).toBe(false)
    expect(isSignedOut(new TypeError('fetch failed'))).toBe(false)
    expect(isSignedOut(null)).toBe(false)
  })
})
