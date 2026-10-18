import type { WorkflowText } from '~/utils/workflow-limits'

/**
 * A workflow run and its steps as the Admin API returns them
 * (specs/Specification_Workflows.md §14) - shared by the Logs
 * slideover and the editor's Test run / Run modal, so both read and show
 * a run the same way.
 */
export interface WorkflowRunSummary {
  id: string
  workflow: string
  version: string | null
  trigger: 'MANUAL' | 'DATA_EVENT' | 'CRON' | 'WEBHOOK'
  mode: 'PRODUCTION' | 'TEST'
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED'
  initiator: unknown
  executor: unknown
  result: unknown
  error: unknown
  /** Followed at least one connected `error` output - it may still have SUCCEEDED. */
  hasHandledErrors: boolean
  historyEnabled: boolean
  historyLevel: 'SUMMARY' | 'DETAILED'
  startedAt: string | null
  finishedAt: string | null
  expiresAt: string
  createdAt: string
}
export interface WorkflowRunStep {
  id: string
  run: string
  operation: string
  operationType: string
  configurationVersion: number
  sequence: number
  predecessor: string | null
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED'
  selectedOutput: string | null
  input: unknown
  result: unknown
  error: unknown
  startedAt: string | null
  finishedAt: string | null
}
/** POST test-run / run, and GET runs/:id: a run with its steps in execution order. */
export interface WorkflowRunOutcome {
  run: WorkflowRunSummary
  steps: WorkflowRunStep[]
}
/** What a step row names: the operation's label and key, from the definition the run used. */
export interface WorkflowRunStepName {
  label: string
  key: string
}

export type RunStatusColor = 'success' | 'error' | 'info' | 'neutral' | 'warning'
const STATUS_COLOR: Record<string, RunStatusColor> = {
  SUCCEEDED: 'success', FAILED: 'error', RUNNING: 'info', PENDING: 'neutral', CANCELLED: 'neutral', INTERRUPTED: 'warning'
}
export function runStatusColor(status: string): RunStatusColor {
  return STATUS_COLOR[status] ?? 'neutral'
}

/** "12ms" / "1.4s", or "—" while unfinished. */
export function runDuration(span: { startedAt: string | null, finishedAt: string | null }): string {
  if (!span.startedAt || !span.finishedAt) return '—'
  const ms = new Date(span.finishedAt).getTime() - new Date(span.startedAt).getTime()
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

// A mutation step's own `input` (the resolved record/set it attempted) is
// redundant once it SUCCEEDED - `result` already holds the real row(s), a
// strict superset (generated id/created_at included). It stops being
// redundant the moment there's no `result` to fall back on - a FAILED
// mutation step is exactly when "what was attempted" is the only useful
// thing left to show.
const MUTATION_RECORD_TYPES = new Set(['totalbase.create-records', 'totalbase.update-records', 'totalbase.delete-records'])
// finish-result's own `input` (its `result` config) and finish-error's
// (`message`/`code`) are always the exact same value already shown as
// `result`/`error` - redundant unconditionally.
const ALWAYS_REDUNDANT_INPUT_TYPES = new Set(['totalbase.finish-result', 'totalbase.finish-error'])
export function inputIsRedundant(step: Pick<WorkflowRunStep, 'operationType' | 'status'>): boolean {
  if (ALWAYS_REDUNDANT_INPUT_TYPES.has(step.operationType)) return true
  return MUTATION_RECORD_TYPES.has(step.operationType) && step.status === 'SUCCEEDED'
}

/**
 * A run's or step's `error` is a `{code, message}` shape - its message as a
 * one-line preview, or null when there's no readable one (rather than
 * dumping raw JSON into a row).
 */
export function errorPreview(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' ? message : null
}

/** Whether a value is worth a block of its own (null/undefined is "none"). */
export function hasPayload(value: unknown): boolean {
  return value !== null && value !== undefined
}

/**
 * Why a production MANUAL run can't start from the editor, or null when it
 * can (Specification_Workflows.md §11.2: production manual runs require an enabled published
 * version; only a MANUAL trigger is started by hand). `liveTrigger` is the
 * published version's Start trigger.
 */
export function manualRunBlocker(workflow: { publishedVersion: string | null, enabled: boolean }, liveTrigger: string | null | undefined, t: WorkflowText): string | null {
  if (!workflow.publishedVersion) return t('workflows.runBlocker.publish')
  // The server's rule (POST /admin/api/workflows/:id/run): a webhook or a
  // data event runs from its own trigger, with its own payload.
  if (liveTrigger !== 'MANUAL' && liveTrigger !== 'CRON') return t('workflows.runBlocker.ownTrigger')
  if (!workflow.enabled) return t('workflows.runBlocker.enable')
  return null
}
