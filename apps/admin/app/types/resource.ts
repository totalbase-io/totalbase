import type { BrokenReferences } from '~/composables/useBrokenReferences'
import type { RowPresentation } from '@totalbase/tb-catalog'

/**
 * Shape of `totalbase.resources` rows as returned by the Admin API
 * (Admin_UI.md §11.1) — verified against the running server,
 * not guessed.
 */
export type ResourceType = 'TABLE' | 'VIEW' | 'FUNCTION'
export type ResourceStatus = 'ACTIVE' | 'MISSING'
export type FunctionClass = 'UNCLASSIFIED' | 'QUERY' | 'ACTION'
export type DataApiMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

/** Verbs the Data API generates per resource type — the ceiling `exposedMethods` can select from (packages/resources' APPLICABLE_METHODS, mirrored here since the admin UI has no server-side import). */
export const APPLICABLE_METHODS: Record<ResourceType, DataApiMethod[]> = {
  TABLE: ['GET', 'POST', 'PATCH', 'DELETE'],
  VIEW: ['GET'],
  FUNCTION: ['POST']
}

export interface Resource {
  id: string
  postgresOid: number
  schema: string
  name: string
  type: ResourceType
  status: ResourceStatus
  /** Which of APPLICABLE_METHODS[type] are actually mounted — a hard ceiling below role permissions. The resource is exposed iff this is non-empty; there's no separate on/off flag. */
  exposedMethods: DataApiMethod[]
  /** TotalBase's own tables: exposure fixed by TotalBase (Security.md §10.1), access decided by grants alone - Endpoints can't be changed. */
  exposureFixed: boolean
  /** TotalBase's own metadata, not a PostgreSQL COMMENT ON — a plain column. */
  description: string | null
  functionClass: FunctionClass | null
  auditRead: boolean
  /** A TABLE's CREATE or a FUNCTION's EXECUTE needs an Idempotency-Key (Data_API.md §9.1). */
  requireIdempotencyKey: boolean
  /** How a row of this table or view shows wherever a foreign key points at it - inherited by those columns (DataViews.md §15.5). */
  rowPresentation: RowPresentation
  /** The order its rows come in when nobody asks for one (Foundations.md §11.7) - the Data API without order_by, a new DataView's default. */
  defaultSort: { column: string, direction: 'asc' | 'desc' }[]
  createdAt: string
  updatedAt: string
}

export interface CatalogRefreshResult {
  discovered: number
  reactivated: number
  missing: number
  /** Resources marked MISSING this same pass (or already MISSING from a previous sync) that got deleted outright - see reconcileResources' own doc comment for why a dropped OID never needs to stick around. Excludes any still referenced by a DataView's source/child, which stay MISSING. */
  purged: number
  /** pg-sync's Pull direction (Foundations.md §11.8) - resources_columns kept in step with each ACTIVE table's real columns. */
  columns: {
    discovered: number
    renamed: number
    removed: number
  }
  /** pg-sync's description ⇄ COMMENT ON sync (Foundations.md §11.8) - only fills whichever side is empty, never overwrites a diverging value. Null while catalog.track_comments is off. */
  descriptions: {
    filledFromComment: number
    filledFromDescription: number
  } | null
  /** What still names what this sync found gone (DataViews.md §4.8) - only when a column was renamed or removed, or a resource went MISSING. */
  brokenReferences?: BrokenReferences | null
}
