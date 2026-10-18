import { checkConstraintValues, templateColumns, type ColumnPresentation } from '@totalbase/tb-catalog'
import type { Resource } from '~/types/resource'
import { SELECT_NONE } from '~/utils/select-none'

/** A column a project added to users (AGENTS.md §11), as the Users screens show and edit it. */
export interface UserExtraColumn {
  name: string
  label: string
  /** Under its input (its presentation's help, else its description). */
  help: string | null
  /** Shown for no value in a list (its presentation's emptyText, else a dash). */
  emptyText: string
  dataType: string
  nullable: boolean
  kind: 'options' | 'boolean' | 'number' | 'date' | 'datetime' | 'json' | 'text'
  /** A foreign key's rows (by its row presentation) or a CHECK list's values - with an empty one when it is nullable. */
  options?: { value: string, label: string }[]
}

interface CatalogColumn { name: string, dataType: string, nullable: boolean }
interface InvitableColumn {
  name: string
  dataType: string
  nullable: boolean
  presentation: ColumnPresentation | null
  relation: { targetSchema: string, targetTable: string, targetColumn: string, rowPresentation: Resource['rowPresentation'] | null } | null
  values: string[] | null
}
interface Catalog {
  columns: CatalogColumn[]
  relations: { sourceColumn: string, targetSchema: string, targetTable: string, targetColumn: string }[]
  checkConstraints?: { expression: string }[]
}

/**
 * The project's own columns on users with what shows them: each column's presentation (label,
 * help, a CHECK list's labels), a foreign key's target rows by that table's row presentation. Empty when the
 * project added none - the Users screens then show nothing extra. Values are read and written through the
 * Data API, like any column.
 */
export function useUserExtraColumns() {
  const api = useAdminApi()
  const dataApi = useDataApi()
  const resourcesApi = useResourcesApi()

  async function load(): Promise<UserExtraColumn[]> {
    const names = (await api.get<{ name: string }[]>('/users/project-columns')).data.map(c => c.name)
    if (names.length === 0) return []
    const resources = await resourcesApi.list()
    const users = resources.find(r => r.schema === 'totalbase' && r.name === 'users')
    if (!users) return []
    const [{ data: catalog }, { data: presentations }] = await Promise.all([
      api.get<Catalog>(`/catalog/table/${users.id}`),
      api.get<{ columnName: string, presentation: ColumnPresentation }[]>(`/resources/${users.id}/columns`)
    ])
    const presentationOf = new Map(presentations.map(p => [p.columnName, p.presentation ?? {}]))
    const checks = (catalog.checkConstraints ?? []).map(c => c.expression)

    return Promise.all(names.map(async (name): Promise<UserExtraColumn> => {
      const column = catalog.columns.find(c => c.name === name) ?? { name, dataType: 'text', nullable: true }
      const presentation = presentationOf.get(name) ?? {}
      const base = {
        name,
        label: presentation.label || humanize(name),
        help: presentation.help || presentation.description || null,
        emptyText: presentation.emptyText || '—',
        dataType: column.dataType,
        nullable: column.nullable
      }
      const relation = catalog.relations.find(r => r.sourceColumn === name)
      if (relation) return { ...base, kind: 'options', options: await targetOptions(resources, relation, column.nullable) }
      const values = checkConstraintValues(name, checks)
      if (values) {
        const labels = (presentation as { options?: Record<string, { label?: string }> }).options ?? {}
        return { ...base, kind: 'options', options: [...(column.nullable ? [{ value: SELECT_NONE, label: '—' }] : []), ...values.map(v => ({ value: v, label: labels[v]?.label || v }))] }
      }
      return { ...base, kind: kindOf(column.dataType) }
    }))
  }

  /**
   * The columns a delegated user may set when inviting (CREATE on users, each granted) - from the
   * App API, which also hands each column's presentation, foreign key target and CHECK list, so nothing here
   * needs the Admin API.
   */
  async function loadInvitable(): Promise<UserExtraColumn[]> {
    const { data: entries } = await useAppApi().get<InvitableColumn[]>('/users/invitation-columns')
    return Promise.all(entries.map(async (entry): Promise<UserExtraColumn> => {
      const presentation = entry.presentation ?? {}
      const base = {
        name: entry.name,
        label: presentation.label || humanize(entry.name),
        help: presentation.help || presentation.description || null,
        emptyText: presentation.emptyText || '—',
        dataType: entry.dataType,
        nullable: entry.nullable
      }
      if (entry.relation) return { ...base, kind: 'options', options: await rowOptions(entry.relation.rowPresentation ?? {}, entry.relation, entry.nullable) }
      if (entry.values) {
        const labels = (presentation as { options?: Record<string, { label?: string }> }).options ?? {}
        return { ...base, kind: 'options', options: [...(entry.nullable ? [{ value: SELECT_NONE, label: '—' }] : []), ...entry.values.map(v => ({ value: v, label: labels[v]?.label || v }))] }
      }
      return { ...base, kind: kindOf(entry.dataType) }
    }))
  }

  /** A foreign key's target rows: the key, labelled by the target's row presentation (else the key itself). */
  async function targetOptions(resources: Resource[], relation: Catalog['relations'][number], nullable: boolean) {
    const target = resources.find(r => r.schema === relation.targetSchema && r.name === relation.targetTable)
    return rowOptions(target?.rowPresentation ?? {}, relation, nullable)
  }

  async function rowOptions(row: Resource['rowPresentation'], relation: Catalog['relations'][number] | Omit<Catalog['relations'][number], 'sourceColumn'>, nullable: boolean) {
    const labelColumns = row.displayTemplate ? templateColumns(row.displayTemplate) : row.displayField ? [row.displayField] : []
    const rows = await dataApi.getAll<Record<string, unknown>>(dataApi.resourcePath(relation.targetSchema, relation.targetTable), {
      fields: [...new Set([relation.targetColumn, ...labelColumns])].join(','),
      ...(labelColumns[0] ? { order_by: labelColumns[0] } : {})
    }).catch(() => [] as Record<string, unknown>[])
    const label = (r: Record<string, unknown>) => row.displayTemplate
      ? row.displayTemplate.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_m, c: string) => String(r[c] ?? ''))
      : String(r[labelColumns[0] ?? relation.targetColumn] ?? r[relation.targetColumn])
    return [...(nullable ? [{ value: SELECT_NONE, label: '—' }] : []), ...rows.map(r => ({ value: String(r[relation.targetColumn]), label: label(r) }))]
  }

  /** A new user's additional data, set after the account exists - PostgreSQL's refusal, or null. */
  async function write(userId: string, values: Record<string, unknown>): Promise<unknown> {
    const data = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== '' && v !== null))
    if (Object.keys(data).length === 0) return null
    try {
      await dataApi.patch(dataApi.resourcePath('totalbase', 'users', 'table', userId), { data })
      return null
    } catch (error) {
      return error
    }
  }

  return { load, loadInvitable, write }
}

function kindOf(dataType: string): UserExtraColumn['kind'] {
  if (dataType === 'boolean') return 'boolean'
  if (/^(smallint|integer|bigint|numeric|real|double precision)/.test(dataType)) return 'number'
  if (dataType === 'date') return 'date'
  if (dataType.startsWith('timestamp')) return 'datetime'
  if (dataType === 'json' || dataType === 'jsonb') return 'json'
  return 'text'
}
function humanize(name: string): string {
  const words = name.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}
