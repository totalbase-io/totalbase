import { describe, expect, it } from 'vitest'
import { parseEmbedParams } from './embed-params'

describe('parseEmbedParams', () => {
  it('reads every parameter', () => {
    expect(parseEmbedParams({
      'theme': 'dark',
      'background': 'false',
      'titled': 'true',
      'hide': 'region, periodo',
      'refresh': '5m',
      'var-region': 'Sur',
      'var-periodo': '2026-01-01..2026-03-31',
      'locale': 'es',
      'var-estado': ['A', 'B']
    })).toEqual({
      theme: 'dark',
      transparent: true,
      titled: true,
      hideBar: false,
      hiddenVariables: ['region', 'periodo'],
      refreshSeconds: 300,
      locale: 'es',
      variables: { region: 'Sur', periodo: '2026-01-01..2026-03-31', estado: ['A', 'B'] }
    })
  })

  it('defaults to nothing, and ignores what it does not know', () => {
    expect(parseEmbedParams({ theme: 'neon', locale: 'xx', refresh: '2s', background: 'no', titled: '1', hide: 'variables', var: 'x' })).toEqual({
      theme: null, transparent: undefined, titled: undefined, hideBar: true, hiddenVariables: [], refreshSeconds: undefined, locale: undefined, variables: {}
    })
  })

  it('maps auto to the system preference, and refresh to the dashboard intervals or off', () => {
    expect(parseEmbedParams({ theme: 'auto' }).theme).toBe('system')
    expect(parseEmbedParams({ refresh: 'off' }).refreshSeconds).toBeNull()
    expect(['30s', '1m', '15m', '1h'].map(r => parseEmbedParams({ refresh: r }).refreshSeconds)).toEqual([30, 60, 900, 3600])
  })
})
