import type { AuditLog } from '~/types/audit'

type Row = Record<string, unknown>

/** One field of a change, as AuditDiff.vue draws it. */
export interface AuditDiffRow {
  field: string
  /** undefined: no before (a CREATE, a first known state). */
  old?: unknown
  /** undefined: no after (a DELETE). */
  new?: unknown
}

/**
 * An UPDATE entry's own before/after (Specification_Security.md §11.4):
 * `changes` holds `{ column: { old, new } }` for every column the update
 * changed, read in the same statement - exact even when an earlier change
 * didn't go through TotalBase (SQL Console, a script). null when the entry
 * has none (a table without a primary key on PostgreSQL 15-17, or nothing
 * changed): callers then compare against the record's previous entry.
 */
export function updateDiffFromChanges(log: Pick<AuditLog, 'action' | 'changes'>): { before: Row, after: Row } | null {
  if (log.action !== 'UPDATE') return null
  const changes = log.changes
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return null
  const before: Row = {}
  const after: Row = {}
  for (const [field, pair] of Object.entries(changes as Row)) {
    if (!pair || typeof pair !== 'object' || !('old' in pair)) return null
    before[field] = (pair as Row).old
    after[field] = (pair as Row).new
  }
  return Object.keys(after).length > 0 ? { before, after } : null
}
