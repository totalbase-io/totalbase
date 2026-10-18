import type { ResourceType } from '~/types/resource'

/**
 * Single source of truth for how a resource type reads visually - icon and
 * color together, everywhere a type shows up (the grid's icon circle, its
 * type badge, the detail slideover). Previously ResourceTypeIcon.vue and
 * resources.vue's typeColor() each hardcoded their own color per type and
 * had drifted apart (VIEW/FUNCTION didn't match between icon and badge) -
 * one map means they can't diverge again.
 *
 * Colors: primary is the app's brand blue (Table, the most common type).
 * View is warning (amber) rather than success (green) - green is already
 * the semantic "succeeded" color elsewhere (toasts, EXECUTED badges);
 * reusing it here would read as a status, not a type. Function is
 * secondary (violet, configured in app.config.ts) - distinct from both.
 *
 * `wrap` classes are spelled out in full (not built from `color` at
 * runtime, e.g. `bg-${color}/10`) - Tailwind's scanner only picks up
 * classes that appear as literal strings in source, not ones assembled
 * via interpolation.
 */
export const RESOURCE_TYPE_STYLE: Record<ResourceType, { icon: string, color: 'primary' | 'warning' | 'secondary', wrap: string }> = {
  TABLE: { icon: 'i-lucide-table', color: 'primary', wrap: 'bg-primary/10 text-primary' },
  VIEW: { icon: 'i-lucide-layout-list', color: 'warning', wrap: 'bg-warning/10 text-warning' },
  FUNCTION: { icon: 'i-lucide-square-function', color: 'secondary', wrap: 'bg-secondary/10 text-secondary' }
}
