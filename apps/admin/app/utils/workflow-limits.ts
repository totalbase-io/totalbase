// Client-side mirror of @totalbase/workflows' WORKFLOW_DEFINITION_LIMITS
// (Specification_Workflows.md §3.6), so the editor refuses before saving
// what the server would refuse with WORKFLOW_LIMIT_EXCEEDED. The server
// stays authoritative; workflow-limits.test.ts keeps the values equal.

export const WORKFLOW_DEFINITION_LIMITS = {
  maxOperations: 100,
  maxConnections: 200,
  maxConfigurationBytes: 65_536,
  maxDefinitionBytes: 1_048_576,
  maxConfigurationDepth: 20,
  maxMapFields: 100,
  maxTemplatePathLength: 1_024
} as const

/**
 * A workflows text by key, with `{param}` placeholders filled - the UI passes
 * vue-i18n's `t` (Specification_Admin_UI.md §14). A caller with no i18n (a
 * unit test) builds one from a locale file with `workflowTextFrom()` - this
 * module never imports the file itself, so the workflows area stays out of
 * every bundle that merely checks a limit (the area loads with its route).
 */
export type WorkflowText = (key: string, params?: Record<string, unknown>) => string
/** A `WorkflowText` reading the messages of one locale file (nested objects, `{param}` placeholders). */
export function workflowTextFrom(messages: Record<string, unknown>): WorkflowText {
  return (key, params = {}) => {
    let value: unknown = messages
    for (const part of key.split('.')) value = (value as Record<string, unknown> | undefined)?.[part]
    return typeof value === 'string' ? value.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? '')) : key
  }
}

const EXPRESSION_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g
const encoder = new TextEncoder()

interface LimitedOperation { key?: string, label?: string, configuration?: unknown }

/** The first limit one operation's configuration passes, as a sentence - or null. */
export function configurationLimitProblem(op: LimitedOperation, t: WorkflowText): string | null {
  const limits = WORKFLOW_DEFINITION_LIMITS
  const name = op.key ? `"${op.key}"` : op.label ? `"${op.label}"` : t('workflows.limits.thisStep')
  const walk = (value: unknown, depth: number): string | null => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(EXPRESSION_PATTERN)) {
        if (match[1]!.length > limits.maxTemplatePathLength) return t('workflows.limits.templatePath', { name, max: limits.maxTemplatePathLength })
      }
      return null
    }
    if (typeof value !== 'object' || value === null) return null
    if (depth > limits.maxConfigurationDepth) return t('workflows.limits.depth', { name, max: limits.maxConfigurationDepth })
    const entries = Array.isArray(value) ? value : Object.values(value)
    if (!Array.isArray(value) && entries.length > limits.maxMapFields) return t('workflows.limits.fields', { name, max: limits.maxMapFields })
    for (const entry of entries) {
      const problem = walk(entry, depth + 1)
      if (problem) return problem
    }
    return null
  }
  const shape = walk(op.configuration, 1)
  if (shape) return shape
  if (encoder.encode(JSON.stringify(op.configuration ?? {})).length > limits.maxConfigurationBytes) {
    return t('workflows.limits.configurationSize', { name, max: limits.maxConfigurationBytes / 1024 })
  }
  return null
}

/** The first definition limit passed, as a sentence - or null. */
export function definitionLimitProblem(definition: { operations: LimitedOperation[], connections: unknown[] }, t: WorkflowText): string | null {
  const limits = WORKFLOW_DEFINITION_LIMITS
  if (definition.operations.length > limits.maxOperations) return t('workflows.limits.operations', { max: limits.maxOperations })
  if (definition.connections.length > limits.maxConnections) return t('workflows.limits.connections', { max: limits.maxConnections })
  for (const op of definition.operations) {
    const problem = configurationLimitProblem(op, t)
    if (problem) return problem
  }
  if (encoder.encode(JSON.stringify(definition)).length > limits.maxDefinitionBytes) return t('workflows.limits.definitionSize')
  return null
}
