import { operationOutputs, type OperationType } from '@totalbase/tb-catalog'
import type { ConditionConfiguration } from '~/components/workflows/ConditionModal.vue'
import type { ForEachConfiguration } from '~/components/workflows/ForEachModal.vue'
import type { SelectCaseConfiguration } from '~/components/workflows/SelectCaseModal.vue'
import type { ReadRecordsConfiguration } from '~/components/workflows/ReadRecordsModal.vue'
import type { CreateRecordsConfiguration } from '~/components/workflows/CreateRecordsModal.vue'
import type { UpdateRecordsConfiguration } from '~/components/workflows/UpdateRecordsModal.vue'
import type { DeleteRecordsConfiguration } from '~/components/workflows/DeleteRecordsModal.vue'
import type { ExecuteFunctionConfiguration } from '~/components/workflows/ExecuteFunctionModal.vue'
import type { ExecuteJavascriptConfiguration } from '~/components/workflows/ExecuteJavascriptModal.vue'
import type { ExecuteSqlConfiguration } from '~/components/workflows/ExecuteSqlModal.vue'
import type { HttpRequestConfiguration } from '~/components/workflows/HttpRequestModal.vue'
import type { SoapRequestConfiguration } from '~/components/workflows/SoapRequestModal.vue'
import type { SignConfiguration } from '~/components/workflows/SignModal.vue'
import type { SendEmailConfiguration } from '~/components/workflows/SendEmailModal.vue'
import type { ReadFileConfiguration } from '~/components/workflows/ReadFileModal.vue'
import type { CreateFileConfiguration } from '~/components/workflows/CreateFileModal.vue'
import type { ParseFileConfiguration } from '~/components/workflows/ParseFileModal.vue'
import type { GenerateFileConfiguration } from '~/components/workflows/GenerateFileModal.vue'
import type { GeneratePdfTemplateConfiguration } from '~/components/workflows/GeneratePdfTemplateModal.vue'
import type { GeneratePdfConfiguration } from '~/components/workflows/GeneratePdfModal.vue'
import type { ExecuteWorkflowConfiguration } from '~/components/workflows/ExecuteWorkflowModal.vue'
import type { WaitResumeConfiguration } from '~/components/workflows/WaitResumeModal.vue'
import type { ProcessBatchesConfiguration } from '~/components/workflows/ProcessBatchesModal.vue'
import type { ValidateDataConfiguration } from '~/components/workflows/ValidateDataModal.vue'
import type { FinishErrorConfiguration } from '~/components/workflows/FinishErrorModal.vue'

/** `t` as the subtitles use it - a plural form for a count (`recordsCount`, `casesCount`). */
export type StepSubtitleText = (key: string, params?: Record<string, unknown>, plural?: number) => string

/** What a step's subtitle reads besides its own configuration. */
export interface StepSubtitleContext {
  t: StepSubtitleText
  /** A resource's name by its catalog id - a table's, a function's. */
  tableName: (id: unknown) => string
  /** A trigger's title (useTriggerOptions) - the Start step's subtitle. */
  triggerTitle: (trigger: string) => string | undefined
}

/**
 * How each step type draws on the canvas (WorkflowStepCard.vue's card look):
 * its kind and color - its icon is the operation catalog's
 * (@totalbase/tb-catalog), its title the node's own label, its subtitle
 * `stepSubtitle()` below. Start isn't here - it has its own look
 * (`nodeView` in pages/workflows/[id].vue). Keyed by the catalog's types, so a
 * new operation without its look fails the typecheck.
 */
export const STEP_NODE_META: Record<Exclude<OperationType, 'totalbase.start'>, { kind: 'condition' | 'action', color: 'warning' | 'info' }> = {
  'totalbase.condition': { kind: 'condition', color: 'warning' },
  'totalbase.for-each': { kind: 'condition', color: 'warning' },
  'totalbase.select-case': { kind: 'condition', color: 'warning' },
  'totalbase.read-records': { kind: 'action', color: 'info' },
  'totalbase.create-records': { kind: 'action', color: 'info' },
  'totalbase.update-records': { kind: 'action', color: 'info' },
  'totalbase.delete-records': { kind: 'action', color: 'info' },
  'totalbase.execute-function': { kind: 'action', color: 'info' },
  'totalbase.execute-javascript': { kind: 'action', color: 'info' },
  'totalbase.execute-sql': { kind: 'action', color: 'info' },
  'totalbase.http-request': { kind: 'action', color: 'info' },
  'totalbase.soap-request': { kind: 'action', color: 'info' },
  'totalbase.sign': { kind: 'action', color: 'info' },
  'totalbase.send-email': { kind: 'action', color: 'info' },
  'totalbase.read-file': { kind: 'action', color: 'info' },
  'totalbase.create-file': { kind: 'action', color: 'info' },
  'totalbase.parse-file': { kind: 'action', color: 'info' },
  'totalbase.generate-file': { kind: 'action', color: 'info' },
  'totalbase.generate-pdf-template': { kind: 'action', color: 'info' },
  'totalbase.generate-pdf': { kind: 'action', color: 'info' },
  'totalbase.execute-workflow': { kind: 'action', color: 'info' },
  'totalbase.wait-resume': { kind: 'action', color: 'info' },
  'totalbase.process-batches': { kind: 'action', color: 'info' },
  'totalbase.validate-data': { kind: 'condition', color: 'warning' },
  'totalbase.finish-error': { kind: 'action', color: 'info' },
  'totalbase.finish-result': { kind: 'action', color: 'info' }
}

/**
 * n8n-style split: `error` is never part of a node's primary branch
 * rotation - it's a separate output a node type either has or doesn't, as
 * the operation catalog says: Start and the two terminal Finish steps don't,
 * every other operation can fail.
 */
export function hasErrorOutput(type: string | undefined): boolean {
  return !!type && (operationOutputs(type, undefined)?.includes('error') ?? false)
}

type Subtitle = (configuration: Record<string, unknown>, ctx: StepSubtitleContext) => string

/** A step's one-line summary under its title, from its configuration - "not configured" until it has one. */
const SUBTITLES: Record<string, Subtitle> = {
  'totalbase.start': (configuration, { t, tableName, triggerTitle }) => {
    const trigger = String(configuration.trigger ?? '')
    if (trigger === 'DATA_EVENT') {
      const events = (configuration.events as string[] | undefined) ?? []
      return `${tableName(configuration.resource)} · ${events.join('/') || t('workflows.editor.noEvents')}`
    }
    return triggerTitle(trigger) ?? t('workflows.editor.notConfigured')
  },
  'totalbase.condition': (configuration, { t }) => {
    const config = configuration as ConditionConfiguration
    if (config.input === undefined && !config.filter) return t('workflows.editor.notConfigured')
    return config.filter ? t('workflows.editor.filtered') : t('workflows.editor.noFilter')
  },
  'totalbase.for-each': (configuration, { t }) => {
    const items = (configuration as ForEachConfiguration).items
    if (items === undefined) return t('workflows.editor.notConfigured')
    return Array.isArray(items) ? t('workflows.editor.itemsCount', { n: items.length }) : t('workflows.editor.configured')
  },
  'totalbase.select-case': (configuration, { t }) => {
    const config = configuration as SelectCaseConfiguration
    const count = config.cases?.length ?? 0
    if (count === 0) return t('workflows.editor.notConfigured')
    return `${t('workflows.editor.casesCount', { n: count }, count)}${config.hasDefault ? ` · ${t('workflows.editor.defaultLower')}` : ''}`
  },
  'totalbase.read-records': (configuration, { t, tableName }) => {
    const config = configuration as ReadRecordsConfiguration
    if (!config.resource) return t('workflows.editor.notConfigured')
    const name = tableName(config.resource)
    const parts: string[] = []
    if (config.query?.where) parts.push(t('workflows.editor.filteredLower'))
    if (config.query?.limit !== undefined) parts.push(t('workflows.editor.limitN', { n: config.query.limit }))
    return parts.length > 0 ? `${name} · ${parts.join(', ')}` : name
  },
  'totalbase.create-records': (configuration, { t, tableName }) => {
    const config = configuration as CreateRecordsConfiguration
    if (!config.resource) return t('workflows.editor.notConfigured')
    if (Array.isArray(config.records)) {
      const count = config.records.length
      return `${tableName(config.resource)} · ${t('workflows.editor.recordsCount', { n: count }, count)}`
    }
    return `${tableName(config.resource)} · ${t('workflows.editor.notConfiguredLower')}`
  },
  'totalbase.update-records': (configuration, { t, tableName }) => {
    const config = configuration as UpdateRecordsConfiguration
    if (!config.resource) return t('workflows.editor.notConfigured')
    return `${tableName(config.resource)} · ${config.where ? t('workflows.editor.filteredLower') : t('workflows.editor.allRows')}`
  },
  'totalbase.delete-records': (configuration, { t, tableName }) => {
    const config = configuration as DeleteRecordsConfiguration
    if (!config.resource) return t('workflows.editor.notConfigured')
    return `${tableName(config.resource)} · ${config.where ? t('workflows.editor.filteredLower') : t('workflows.editor.allRows')}`
  },
  'totalbase.execute-function': (configuration, { t, tableName }) => {
    const config = configuration as ExecuteFunctionConfiguration
    return config.function ? tableName(config.function) : t('workflows.editor.notConfigured')
  },
  'totalbase.execute-javascript': (configuration, { t }) => {
    const config = configuration as ExecuteJavascriptConfiguration
    return config.code?.trim() ? t('workflows.editor.linesCount', { n: config.code.trim().split('\n').length }) : t('workflows.editor.notConfigured')
  },
  'totalbase.execute-sql': (configuration, { t }) => ((configuration as ExecuteSqlConfiguration).statement?.trim() ? t('workflows.editor.configured') : t('workflows.editor.notConfigured')),
  'totalbase.http-request': (configuration, { t }) => {
    const config = configuration as HttpRequestConfiguration
    return config.url ? `${config.method ?? 'GET'} ${config.url}` : t('workflows.editor.notConfigured')
  },
  'totalbase.soap-request': (configuration, { t }) => {
    const config = configuration as SoapRequestConfiguration
    if (!config.operation || !config.url) return t('workflows.editor.notConfigured')
    let host = config.url
    try {
      host = new URL(config.url).host
    } catch { /* a {{template}} URL shows as written */ }
    return `${config.operation} · ${host}`
  },
  'totalbase.sign': (configuration, { t }) => {
    const config = configuration as SignConfiguration
    return config.certificate && config.privateKey && config.data ? `CMS · ${config.certificate}` : t('workflows.editor.notConfigured')
  },
  'totalbase.send-email': (configuration, { t }) => {
    const config = configuration as SendEmailConfiguration
    return config.to ? config.to : t('workflows.editor.notConfigured')
  },
  'totalbase.read-file': (configuration, { t }) => ((configuration as ReadFileConfiguration).asset ? t('workflows.editor.configured') : t('workflows.editor.notConfigured')),
  'totalbase.create-file': (configuration, { t }) => (configuration as CreateFileConfiguration).name ?? t('workflows.editor.notConfigured'),
  'totalbase.parse-file': (configuration, { t }) => {
    const config = configuration as ParseFileConfiguration
    return config.asset ? (config.format ?? 'csv').toUpperCase() : t('workflows.editor.notConfigured')
  },
  'totalbase.generate-file': configuration => ((configuration as GenerateFileConfiguration).format ?? 'json').toUpperCase(),
  'totalbase.generate-pdf-template': (configuration, { t }) => ((configuration as GeneratePdfTemplateConfiguration).template ? t('workflows.editor.configured') : t('workflows.editor.notConfigured')),
  'totalbase.generate-pdf': (configuration, { t }) => ((configuration as GeneratePdfConfiguration).design ? t('workflows.editor.configured') : t('workflows.editor.notConfigured')),
  'totalbase.execute-workflow': (configuration, { t }) => ((configuration as ExecuteWorkflowConfiguration).workflow ? t('workflows.editor.configured') : t('workflows.editor.notConfigured')),
  'totalbase.wait-resume': configuration => `${(configuration as WaitResumeConfiguration).waitSeconds ?? 60}s`,
  'totalbase.process-batches': (configuration, { t }) => t('workflows.editor.batchesOf', { n: (configuration as ProcessBatchesConfiguration).batchSize ?? 50 }),
  'totalbase.validate-data': (configuration, { t }) => ((configuration as ValidateDataConfiguration).rules ? t('workflows.editor.configured') : t('workflows.editor.notConfigured')),
  'totalbase.finish-error': (configuration, { t }) => (configuration as FinishErrorConfiguration).message ?? t('workflows.editor.notConfigured'),
  'totalbase.finish-result': (_configuration, { t }) => t('workflows.editor.configured')
}

/** A step's subtitle on the canvas - empty for a type the editor doesn't know. */
export function stepSubtitle(type: string, configuration: Record<string, unknown> | undefined, ctx: StepSubtitleContext): string {
  const subtitle = SUBTITLES[type]
  return subtitle ? subtitle(configuration ?? {}, ctx) : ''
}
