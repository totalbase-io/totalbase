import { describe, expect, it } from 'vitest'
import { errorPreview, inputIsRedundant, manualRunBlocker as blocker, runDuration, runStatusColor } from './workflow-runs'
import { workflowTextFrom } from './workflow-limits'
// The English source texts - the UI passes vue-i18n's `t`; here the file itself.
import enWorkflows from '../../i18n/locales/en/workflows.json'

const t = workflowTextFrom(enWorkflows)
const manualRunBlocker = (workflow: Parameters<typeof blocker>[0], trigger: Parameters<typeof blocker>[1]) => blocker(workflow, trigger, t)

describe('manualRunBlocker()', () => {
  const ready = { publishedVersion: 'v-id', enabled: true }

  it('lets an enabled, published MANUAL workflow run', () => {
    expect(manualRunBlocker(ready, 'MANUAL')).toBeNull()
  })
  it('asks to publish first, whatever else is true', () => {
    expect(manualRunBlocker({ publishedVersion: null, enabled: false }, undefined)).toMatch(/Publish/)
  })
  it('runs a scheduled workflow now too; refuses a webhook, a data event, or a trigger not known yet', () => {
    expect(manualRunBlocker(ready, 'CRON')).toBeNull()
    expect(manualRunBlocker(ready, 'WEBHOOK')).toMatch(/own trigger/)
    expect(manualRunBlocker(ready, 'DATA_EVENT')).toMatch(/own trigger/)
    expect(manualRunBlocker(ready, undefined)).toMatch(/own trigger/)
  })
  it('asks to enable a published MANUAL workflow', () => {
    expect(manualRunBlocker({ ...ready, enabled: false }, 'MANUAL')).toMatch(/Enable/)
  })
})

describe('run helpers', () => {
  it('formats a duration, or a dash while unfinished', () => {
    expect(runDuration({ startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:00.120Z' })).toBe('120ms')
    expect(runDuration({ startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:02.500Z' })).toBe('2.5s')
    expect(runDuration({ startedAt: '2026-01-01T00:00:00.000Z', finishedAt: null })).toBe('—')
  })
  it('colors a status, neutral when unknown', () => {
    expect(runStatusColor('SUCCEEDED')).toBe('success')
    expect(runStatusColor('FAILED')).toBe('error')
    expect(runStatusColor('WHATEVER')).toBe('neutral')
  })
  it('hides an input the result already shows', () => {
    expect(inputIsRedundant({ operationType: 'totalbase.finish-result', status: 'FAILED' })).toBe(true)
    expect(inputIsRedundant({ operationType: 'totalbase.create-records', status: 'SUCCEEDED' })).toBe(true)
    expect(inputIsRedundant({ operationType: 'totalbase.create-records', status: 'FAILED' })).toBe(false)
    expect(inputIsRedundant({ operationType: 'totalbase.read-records', status: 'SUCCEEDED' })).toBe(false)
  })
  it('previews an error by its message only', () => {
    expect(errorPreview({ code: 'X', message: 'Boom' })).toBe('Boom')
    expect(errorPreview({ code: 'X' })).toBeNull()
    expect(errorPreview(null)).toBeNull()
  })
})
