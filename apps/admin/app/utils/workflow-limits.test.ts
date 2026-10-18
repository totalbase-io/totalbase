import { describe, expect, it } from 'vitest'
// The server's constants, read straight from their source - this test is
// what keeps the editor's mirror equal to them.
import { WORKFLOW_DEFINITION_LIMITS as SERVER_LIMITS } from '../../../../packages/workflows/src/execution/definition-limits'
import { configurationLimitProblem as configurationProblem, definitionLimitProblem as definitionProblem, WORKFLOW_DEFINITION_LIMITS as LIMITS, workflowTextFrom } from './workflow-limits'
// The English source texts - the UI passes vue-i18n's `t`; here the file itself.
import enWorkflows from '../../i18n/locales/en/workflows.json'

const t = workflowTextFrom(enWorkflows)
const configurationLimitProblem = (op: Parameters<typeof configurationProblem>[0]) => configurationProblem(op, t)
const definitionLimitProblem = (definition: Parameters<typeof definitionProblem>[0]) => definitionProblem(definition, t)
const op = (key: string, configuration: unknown = {}) => ({ key, configuration })

describe('workflow limits mirror', () => {
  it('equals the server limits', () => {
    expect(LIMITS).toEqual(SERVER_LIMITS)
  })

  it('accepts a definition within every limit', () => {
    expect(definitionLimitProblem({ operations: Array.from({ length: LIMITS.maxOperations }, (_, i) => op(`s${i}`)), connections: [] })).toBeNull()
  })

  it('names each limit passed', () => {
    expect(definitionLimitProblem({ operations: Array.from({ length: LIMITS.maxOperations + 1 }, (_, i) => op(`s${i}`)), connections: [] })).toContain('at most 100 steps')
    expect(definitionLimitProblem({ operations: [], connections: Array.from({ length: LIMITS.maxConnections + 1 }) })).toContain('200 connections')
    expect(configurationLimitProblem(op('big', { result: 'x'.repeat(LIMITS.maxConfigurationBytes) }))).toContain('"big"')
    let deep: Record<string, unknown> = {}
    for (let i = 0; i < LIMITS.maxConfigurationDepth; i++) deep = { inner: deep }
    expect(configurationLimitProblem(op('deep', deep))).toContain('levels deep')
    expect(configurationLimitProblem(op('wide', { set: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`f${i}`, i])) }))).toContain('fields')
    expect(configurationLimitProblem(op('path', { text: `{{start.data.${'a'.repeat(LIMITS.maxTemplatePathLength)}}}` }))).toContain('template path')
    const huge = Array.from({ length: 20 }, (_, i) => op(`s${i}`, { result: 'x'.repeat(60_000) }))
    expect(definitionLimitProblem({ operations: huge, connections: [] })).toContain('1 MiB')
  })
})
