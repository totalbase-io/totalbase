import type { CreationConfig } from '@totalbase/tb-catalog'
import type { CatalogColumn } from '~/types/permission'

/** Row shape of GET /catalog/schemas. */
export interface CatalogSchemaSummary {
  schema: string
  objectCount: number
}

/** Row shape of GET /catalog/tables|views|functions. */
export interface CatalogObjectSummary {
  oid: number
  schema: string
  name: string
  relationKind: string
  resourceType: 'TABLE' | 'VIEW' | 'FUNCTION'
}

export interface RelationDefinition {
  name: string
  sourceColumn: string
  targetSchema: string
  targetTable: string
  targetColumn: string
}

export interface CheckConstraintDefinition {
  name: string
  expression: string
  /** The constraint's own COMMENT ("Error Message" in the Add form) - null if never set. */
  message: string | null
  /** The columns the expression names (pg_constraint.conkey) - one for a single-column CHECK. */
  columns: string[]
}

/** GET /catalog/columns?schema= — every table's and view's column names in a schema. */
export interface RelationColumns {
  oid: number
  schema: string
  name: string
  resourceType: 'TABLE' | 'VIEW'
  columns: string[]
}

/** GET /catalog/table|view/{oid} — full structural detail. */
export interface RelationDetail {
  columns: CatalogColumn[]
  primaryKey: string[]
  relations: RelationDefinition[]
  uniqueConstraints: string[][]
  uniqueConstraintNames: string[]
  checkConstraints: CheckConstraintDefinition[]
  /** The PostgreSQL role that owns it. */
  owner: string
  /** The configured PostgreSQL role may alter/drop it (owner or member of the owner role) - Administration.md §3.15. */
  canAlter: boolean
}

/** GET /catalog/table/{oid}/indexes. */
export interface IndexDefinition {
  name: string
  columns: string[]
  /** The keys with their direction - what the Edit Table drawer rebuilds an index from. */
  keys: { name: string, direction: 'asc' | 'desc' }[]
  /** A partial index's WHERE as PostgreSQL renders it; null for a whole-table index. */
  predicate: string | null
  isUnique: boolean
  isPrimary: boolean
  method: string
}

export interface FunctionParameter {
  name: string
  dataType: string
  hasDefault: boolean
}

/** GET /catalog/function/{oid}. */
export interface FunctionDetail {
  parameters: FunctionParameter[]
  returnsRows: boolean
  /** The PostgreSQL role that owns it. */
  owner: string
  /** The configured PostgreSQL role may alter/drop it (owner or member of the owner role) - Administration.md §3.15. */
  canAlter: boolean
}

/**
 * Schema-mutation request bodies (Administration.md §3) - what goes
 * inside the request's `{ data }`, camelCase like every API body
 * (Data_API.md §2.5).
 */
export type FkAction = 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT'

export interface InlineForeignKeyBody {
  targetSchema: string
  targetTable: string
  targetColumn: string
  onDelete?: FkAction
  onUpdate?: FkAction
}

export interface ColumnBody {
  name: string
  /** Required unless `creation` is sent - the server derives it from the entry then. */
  dataType?: string
  nullable?: boolean
  default?: string
  primaryKey?: boolean
  /**
   * Inline single-column UNIQUE/CHECK/REFERENCES - folded into the same
   * CREATE TABLE / ADD COLUMN statement as the rest of the column so it's
   * all-or-nothing (AGENTS.md §41: table creation feeds straight into
   * exposing endpoints, so a column existing without its relationship
   * actually attached is worse than the whole thing failing up front).
   * Still fully manageable afterward through the named constraint
   * endpoints below - Postgres names these the same either way.
   */
  unique?: boolean
  check?: string
  foreignKey?: InlineForeignKeyBody
  /** Add Column wizard only - the column input catalog entry picked (its presentation's `input`), written into totalbase.resources_columns once the column exists (DataViews.md §16.2). Omitted by every other caller: Automatic. */
  input?: string
  config?: unknown
  /** Add Column only: a UID column generated from `source` (DataViews.md §16.3). */
  uid?: { source: string }
  /** Add Column only, with `input`: the entry's creation config - the server derives dataType/check/foreignKey/uid/unique from it (never built here). */
  creation?: CreationConfig
}

export interface AlterColumnBody {
  rename?: string
  dataType?: string
  nullable?: boolean
  default?: string | null
}

export interface ForeignKeyBody {
  column: string
  targetSchema: string
  targetTable: string
  targetColumn: string
  onDelete?: FkAction
  onUpdate?: FkAction
  name?: string
}

/**
 * Index builder (Administration.md §3.10 leaves this to SQL Console for
 * v1 - the Edit Table drawer's Indexes tab covers it directly instead,
 * per team decision). Mirrors packages/schema's IndexMethod/IndexSummary.
 */
export type IndexMethod = 'btree' | 'hash' | 'gist' | 'gin' | 'spgist' | 'brin'

export interface IndexSummary {
  name: string
  definition: string
  isUnique: boolean
  isPrimary: boolean
}

/** A plain column name sorts ascending (Postgres's own default); an object requests DESC. */
export interface IndexColumnBody {
  name: string
  direction?: 'asc' | 'desc'
}

/**
 * Wire format for one entry in the Edit Table drawer's batch - the
 * drawer diffs its draft against the table's original state and sends
 * the resulting list here. Mirrors apps/server's EditOperationBody.
 */
export type EditOperationBody
  = | { kind: 'rename_table', newName: string }
    | { kind: 'add_column', column: ColumnBody }
    | { kind: 'alter_column', column: string, patch: AlterColumnBody }
    | { kind: 'drop_column', column: string, cascade?: boolean }
    | { kind: 'set_primary_key', columns: string[] }
    | { kind: 'add_unique', columns: string[], name?: string }
    | { kind: 'add_foreign_key', column: string, targetSchema: string, targetTable: string, targetColumn: string, onDelete?: FkAction, onUpdate?: FkAction, name?: string }
    | { kind: 'add_check', name: string, expression: string }
    | { kind: 'drop_constraint', name: string }
    | { kind: 'create_index', name?: string, columns: IndexColumnBody[], method?: IndexMethod, unique?: boolean, where?: string, concurrently?: boolean }
    | { kind: 'drop_index', name: string, concurrently?: boolean }

/** Response of POST .../edit/preview - the SQL preview the Save flow confirms before committing. */
export interface TableEditPlan {
  /** Runs together in one transaction - all succeed or the whole batch rolls back. */
  transactional: string[]
  /** CONCURRENTLY statements - PostgreSQL forbids these inside a transaction block, so they run afterward, each on its own. */
  concurrent: string[]
}
