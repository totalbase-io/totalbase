/**
 * A DataView's custom actions at runtime (Specification_DataViews.md §3.7): which show where - only those the viewer
 * may run (`actionTargets`, the server's), on a row only when its condition holds there (a flag PostgreSQL answered) -
 * and what each sends.
 */
import type { CustomAction, CustomActionPlace } from '@totalbase/tb-catalog'

/** What an action calls, as the App's DataView says - only for those this viewer may run. */
export type ActionTarget = { kind: 'FUNCTION', schema: string, name: string } | { kind: 'WORKFLOW', slug: string }

/** An action's icon when it sets none. */
export const CUSTOM_ACTION_ICON = 'i-lucide-zap'

/** An action this viewer may run, with what it calls. */
export interface RunnableAction {
  action: CustomAction
  target: ActionTarget
}

/** The DataView's actions this viewer may run, in their order. */
export function runnableActions(viewConfig: Record<string, unknown> | undefined, targets: Record<string, ActionTarget> | undefined): RunnableAction[] {
  const actions = Array.isArray(viewConfig?.custom_actions) ? viewConfig.custom_actions as CustomAction[] : []
  return actions.flatMap(action => (targets?.[action.id] ? [{ action, target: targets[action.id]! }] : []))
}

/** An action's flag - its condition, sent with a read (`flags[a_<id>]`). */
export const actionFlag = (action: CustomAction) => `a_${action.id}`

/** The read's `flags` for the actions with a condition shown at `places`. */
export function actionFlags(runnable: readonly RunnableAction[], places: readonly CustomActionPlace[]): Record<string, Record<string, unknown>> {
  return Object.fromEntries(runnable
    .filter(r => r.action.where && r.action.places.some(p => places.includes(p)))
    .map(r => [actionFlag(r.action), r.action.where!]))
}

/** The actions shown at `place` - on a row (or a record) only those whose condition its flags say holds. */
export function actionsAt(runnable: readonly RunnableAction[], place: CustomActionPlace, met?: readonly string[]): RunnableAction[] {
  return runnable.filter(r => r.action.places.includes(place) && (place === 'selection' || !r.action.where || (met ?? []).includes(actionFlag(r.action))))
}

/** `{{column}}` in a text, from the row - an absent value, nothing. */
export function fillText(template: string, row: Record<string, unknown> | undefined): string {
  return template.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (_, column: string) => {
    const value = row?.[column]
    return value === null || value === undefined ? '' : String(value)
  })
}

/**
 * What the action sends for `rows` (one, or a selection): each argument's template - exactly `{{column}}` the row's
 * value as it is, `{{ids}}` the keys of every row, text with `{{column}}` in it filled - and without any, the key:
 * `ids` for a selection, `id` for a row.
 */
export function actionInput(action: CustomAction, rows: readonly Record<string, unknown>[], primaryKey: string): Record<string, unknown> {
  const ids = rows.map(row => row[primaryKey])
  const first = rows[0]
  const args = action.args ?? {}
  if (Object.keys(args).length === 0) return rows.length === 1 ? { id: ids[0] } : { ids }
  return Object.fromEntries(Object.entries(args).map(([name, template]) => {
    const whole = /^\{\{\s*([^{}\s]+)\s*\}\}$/.exec(template.trim())
    if (whole?.[1] === 'ids') return [name, ids]
    if (whole) return [name, first?.[whole[1]!] ?? null]
    return [name, fillText(template, first)]
  }))
}
