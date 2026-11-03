import { describe, expect, it } from 'vitest'
import type { DashboardVariable } from '~/types/dashboard'
import { dateRangeLabel, decodeVariableValues, encodeVariableValues, formatCustomRange } from './dashboard-variables'

const day: DashboardVariable = { name: 'period', label: 'Period', type: 'DATE_RANGE' }
const minute: DashboardVariable = { name: 'period', label: 'Period', type: 'DATE_RANGE', precision: 'minute' }
const presetLabel = (preset: { value: string, label: string }) => `L:${preset.label}`

describe('a DATE_RANGE in the URL (Dashboards.md §3.7)', () => {
  it('writes a custom range as from..to, each bound as sent, and reads both grammars back', () => {
    expect(encodeVariableValues([day], { period: { from: '2026-11-02', to: '2026-11-03' } })).toEqual({ period: '2026-11-02..2026-11-03' })
    expect(encodeVariableValues([minute], { period: { from: '2026-11-02T22:30', to: '2026-11-03T09:00' } })).toEqual({ period: '2026-11-02T22:30..2026-11-03T09:00' })
    expect(decodeVariableValues([day], { period: '2026-11-02..2026-11-03' })).toEqual({ period: { from: '2026-11-02', to: '2026-11-03' } })
    expect(decodeVariableValues([minute], { period: '2026-11-02T22:30..2026-11-03T09:00' })).toEqual({ period: { from: '2026-11-02T22:30', to: '2026-11-03T09:00' } })
    // A bare date beside a time - the server widens it (§3.4); the decoder only carries it.
    expect(decodeVariableValues([minute], { period: '2026-11-02..2026-11-03T09:00' })).toEqual({ period: { from: '2026-11-02', to: '2026-11-03T09:00' } })
    expect(decodeVariableValues([day], { period: 'last_7_days' })).toEqual({ period: 'last_7_days' })
    expect(decodeVariableValues([day], { period: '' })).toEqual({ period: null })
  })
})

describe('what a DATE_RANGE reads as', () => {
  it('formats a custom range in the regional format, wall-clock parts as written', () => {
    expect(formatCustomRange({ from: '2026-11-02', to: '2026-11-03' }, 'day', 'es-AR')).toBe('02/11/2026 – 03/11/2026')
    expect(formatCustomRange({ from: '2026-11-02', to: '2026-11-03' }, undefined, 'en-US')).toBe('11/02/2026 – 11/03/2026')
    expect(formatCustomRange({ from: '2026-11-02T22:30', to: '2026-11-03T09:00' }, 'minute', 'es-AR')).toMatch(/^02\/11\/2026,? 22:30 – 03\/11\/2026,? 09:00$/)
    // A bare date at minute precision reads as midnight - what the server makes of it.
    expect(formatCustomRange({ from: '2026-11-02', to: '2026-11-03T09:00' }, 'minute', 'es-AR')).toMatch(/^02\/11\/2026,? 00:00 – /)
  })

  it('a preset\'s name, unset reading as All time', () => {
    expect(dateRangeLabel(day, 'last_7_days', 'es-AR', presetLabel)).toBe('L:Last 7 days')
    expect(dateRangeLabel(day, null, 'es-AR', presetLabel)).toBe('L:All time')
    expect(dateRangeLabel(minute, { from: '2026-11-02', to: '2026-11-03' }, 'en-US', presetLabel)).toMatch(/^11\/02\/2026,? 00:00 – 11\/04\/2026|^11\/02\/2026,? 00:00 – 11\/03\/2026/)
  })
})
