import type { CatalogColumn } from '~/types/permission'

/** The types a column's type picker offers - any other PostgreSQL type can still be typed in. */
export const BASE_TYPES = [
  'uuid', 'text', 'varchar', 'char', 'integer', 'bigint', 'smallint',
  'numeric', 'boolean', 'timestamptz', 'timestamp', 'date', 'jsonb', 'text[]'
]
export const LENGTH_TYPES = new Set(['varchar', 'char', 'character', 'character varying'])
export const PRECISION_TYPES = new Set(['numeric', 'decimal'])

/** A column's type as edited: its base apart from a length or a precision and scale. */
export interface DataTypeParts {
  base: string
  length?: string
  precision?: string
  scale?: string
}

/**
 * A column's type in parts, from the catalog's own (typeName, typeLength, typePrecision, typeScale) - a domain column's
 * are its base type's, so the domain itself is the base and has none.
 */
export function dataTypeParts(column: Pick<CatalogColumn, 'dataType' | 'typeName' | 'typeLength' | 'typePrecision' | 'typeScale' | 'domain'>): DataTypeParts {
  const base = column.domain ?? column.typeName ?? column.dataType
  if (column.domain) return { base }
  return {
    base,
    length: LENGTH_TYPES.has(base) && column.typeLength != null ? String(column.typeLength) : undefined,
    precision: PRECISION_TYPES.has(base) && column.typePrecision != null ? String(column.typePrecision) : undefined,
    scale: PRECISION_TYPES.has(base) && column.typeScale != null ? String(column.typeScale) : undefined
  }
}

/** The one type string PostgreSQL takes back - `numeric(12,2)`, `varchar(80)`, `text`. */
export function composeDataType(parts: DataTypeParts): string {
  const base = parts.base.trim()
  if (LENGTH_TYPES.has(base) && parts.length) return `${base}(${parts.length})`
  if (PRECISION_TYPES.has(base)) {
    if (parts.precision && parts.scale) return `${base}(${parts.precision},${parts.scale})`
    if (parts.precision) return `${base}(${parts.precision})`
  }
  return base
}

/** The column's current type, as composeDataType writes it - what an edit is compared against. */
export function currentDataType(column: Pick<CatalogColumn, 'dataType' | 'typeName' | 'typeLength' | 'typePrecision' | 'typeScale' | 'domain'>): string {
  return column.domain ?? composeDataType(dataTypeParts(column))
}
