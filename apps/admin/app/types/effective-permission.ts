import type { PermissionAction, PermissionEffect } from '~/types/permission'

/** Shape of GET /users/{id}/effective-permissions and /roles/{id}/effective-permissions. */
export interface BulkActionDecision {
  decision: PermissionEffect | 'UNDEFINED'
  roles: string[]
  /** Effectively granted columns, sorted - only present when decision === 'ALLOW'. Informational only (see effective-permission-service.ts's doc comment) - not what actually gates a Data API request. */
  fields?: string[]
  /** ALLOW limited to some rows: each ALLOW grant's row filter, OR-combined. Absent = every row. */
  rowFilters?: Array<{ role: string, where: unknown }>
  /** Payload checks that apply (every one must pass), with the role each comes from. */
  payloadChecks?: Array<{ role: string, label: string | null, rule: unknown }>
}

export interface EffectiveResourceEntry {
  resource: string
  actions: Record<PermissionAction, BulkActionDecision>
}
