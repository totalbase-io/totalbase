/**
 * The dashboard assistant's screen (Dashboards.md §10.7, D27): the shapes
 * `POST /admin/api/dashboards/suggest` answers and the pure steps between its proposal and
 * the spec `POST /admin/api/dashboards/spec` creates - which widgets are ticked, keeping
 * them across a security option, and the final spec. Nothing here decides a widget or a
 * query: the server proposes, the screen only picks.
 */
import type { DashboardTab, DashboardVariable } from '~/types/dashboard'

/** A decision with its reason (§5.19): a fixed code, the sentence in the App's language, an unchanging detail. */
export interface SuggestDecision {
  code: string
  message: string
  detail?: string
}

export type SuggestColumnRole = 'moment' | 'deadline' | 'measure' | 'category' | 'dimension' | 'identifier' | 'place' | 'file' | 'discarded'

/** One widget of a spec (§8.3) - the assistant's carry no id and no grid. */
export interface SuggestSpecWidget {
  id?: string
  type: string
  label?: string | null
  tab?: string | null
  grid?: { x: number, y: number, w: number, h: number }
  query?: string | null
  config?: Record<string, unknown>
}

export interface SuggestSpec {
  name: string
  slug?: string
  description?: string | null
  icon?: string | null
  menuLabel?: string | null
  color?: string | null
  scope?: 'LISTED' | 'EMBEDDED_ONLY'
  refreshIntervalSeconds?: number | null
  variables?: DashboardVariable[]
  tabs?: DashboardTab[]
  widgets: SuggestSpecWidget[]
}

export interface SuggestColumnAnalysis {
  column: string
  role: SuggestColumnRole
  reason: SuggestDecision
  alternatives?: string[]
  origin?: string
  aggregate?: 'sum' | 'avg'
  values?: string[]
  references?: string
}

export interface SuggestSecurityOption {
  key: 'openOnViewers' | 'onlyViewers'
  column: string
  field: string
  reason: SuggestDecision
  spec: SuggestSpec
  more: SuggestSpecWidget[]
}

export interface DashboardSuggestion {
  relation: { schema: string, name: string, type: 'TABLE' | 'VIEW', resourceId: string | null }
  analysis: SuggestColumnAnalysis[]
  spec: SuggestSpec
  more: SuggestSpecWidget[]
  reasons: { path: string, reason: SuggestDecision }[]
  missing: SuggestDecision[]
  security: { notice: SuggestDecision, options: SuggestSecurityOption[] }
}

/** What `POST /admin/api/dashboards/spec` answers. */
export interface DashboardApplyResult {
  id: string
  created: boolean
  applied: boolean
  draftVersion: string
  widgets: unknown[]
}

/** The proposal the review step works on: the suggestion's own, or a security option's. */
export interface SuggestBase {
  spec: SuggestSpec
  more: SuggestSpecWidget[]
}

/** One checkbox of the review: a proposed widget and where it comes from (`widgets[i]` ticked, `more[i]` not). */
export interface WidgetChoice {
  key: string
  widget: SuggestSpecWidget
  proposed: boolean
}

/** Every widget of a proposal, the ticked ones first - in the order the dashboard would show them. */
export function widgetChoices(base: SuggestBase): WidgetChoice[] {
  return [
    ...base.spec.widgets.map((widget, i) => ({ key: `widgets[${i}]`, widget, proposed: true })),
    ...base.more.map((widget, i) => ({ key: `more[${i}]`, widget, proposed: false }))
  ]
}

/** A widget's identity across proposals (a security option drops or filters some): its type and its title. */
export function widgetIdentity(widget: SuggestSpecWidget): string {
  return `${widget.type}\u0000${widget.label ?? ''}`
}

/** The proposal's own ticks: its spec's widgets. */
export function defaultTicks(base: SuggestBase): Set<string> {
  return new Set(widgetChoices(base).filter(c => c.proposed).map(c => c.key))
}

/**
 * The ticks carried to another proposal (a security option chosen or left): a widget the
 * user had ticked stays ticked, one they had left out stays out, by its type and title; a
 * widget only the new proposal has keeps its default.
 */
export function carryTicks(from: SuggestBase, ticks: ReadonlySet<string>, to: SuggestBase): Set<string> {
  const before = new Map<string, boolean>()
  for (const choice of widgetChoices(from)) {
    const identity = widgetIdentity(choice.widget)
    if (!before.has(identity)) before.set(identity, ticks.has(choice.key))
  }
  const next = new Set<string>()
  for (const choice of widgetChoices(to)) {
    const kept = before.get(widgetIdentity(choice.widget))
    if (kept ?? choice.proposed) next.add(choice.key)
  }
  return next
}

/**
 * The spec to create: the proposal with its name and only the ticked widgets (its spec's,
 * then `more`'s), without a grid - the server places them in order at their default size.
 */
export function buildFinalSpec(base: SuggestBase, ticks: ReadonlySet<string>, name: string): SuggestSpec {
  const widgets = widgetChoices(base)
    .filter(choice => ticks.has(choice.key))
    .map(({ widget }) => {
      const { grid: _grid, id: _id, ...rest } = widget
      return rest
    })
  return { ...base.spec, name: name.trim(), widgets }
}

/** A widget's reason, from the suggestion's `reasons` - by its path, or by its type and title in a security option's proposal. */
export function widgetReasons(suggestion: DashboardSuggestion): Map<string, SuggestDecision> {
  const byPath = new Map(suggestion.reasons.map(r => [r.path, r.reason]))
  const byIdentity = new Map<string, SuggestDecision>()
  for (const choice of widgetChoices(suggestion)) {
    const reason = byPath.get(choice.key)
    if (reason) byIdentity.set(widgetIdentity(choice.widget), reason)
  }
  return byIdentity
}
