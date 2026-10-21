import { columnFormInput, type ColumnPresentation, type WidgetName } from '@totalbase/tb-catalog'
import type { DataView } from '~/types/dataview'
import type { CatalogColumn } from '~/types/permission'
import type { RelationDefinition, RelationDetail } from '~/types/schema'
import { humanizeColumnName } from '~/utils/humanize-column-name'
import type { JunctionCandidate } from '~/utils/junction-links'

/**
 * The record of a designed page - its source table (DataViews.md
 * §8.5): its columns and foreign keys, for a form field bound to a column,
 * and what each column's presentation sets (its title, its input).
 */
export function useDesignerRecord(getDataview: () => DataView) {
  const api = useAdminApi()
  // Its identity is read once; its presentation live (the host reads the DataView again after a save).
  const dataview = getDataview()
  /** The record table's catalog id - null when the page has no record (no source, or a view). */
  const recordTable = dataview.sourceResourceType === 'TABLE' ? dataview.sourceResource : null
  const { data: recordCatalog } = useAsyncData(`custom-record-${dataview.id}`,
    () => (recordTable ? api.get<RelationDetail>(`/catalog/table/${recordTable}`).then(r => r.data) : Promise.resolve(null)),
    { default: () => null })
  const recordTableName = recordTable && dataview.sourceResourceSchema && dataview.sourceResourceName
    ? { schema: dataview.sourceResourceSchema, name: dataview.sourceResourceName }
    : null
  /** Its junction tables (DataViews.md §8.5) - what a form field's Junction table offers. */
  const { data: recordJunctions } = useAsyncData(`custom-record-junctions-${dataview.id}`,
    () => (recordTable ? api.get<JunctionCandidate[]>('/dataviews/junctions', { record: recordTable }).then(r => r.data) : Promise.resolve([])),
    { default: () => [] as JunctionCandidate[] })
  const recordColumns = computed<CatalogColumn[]>(() => recordCatalog.value?.columns ?? [])
  const recordRelations = computed<RelationDefinition[]>(() => recordCatalog.value?.relations ?? [])

  /** What a column of the page's record sets - what a form field bound to it inherits (the draft's, live). */
  function recordPresentation(column: string): ColumnPresentation | undefined {
    const current = getDataview()
    return current.columnPresentation?.[current.sourceResource ?? '']?.[column]
  }
  /** The title a form field bound to `column` shows with none of its own - its column's, else its name humanized. */
  function columnTitle(column: string): string {
    return recordPresentation(column)?.label ?? humanizeColumnName(column)
  }
  /** The input a column is edited with - its presentation's, else the rule (DataViews.md §15.2), as the server reads it. */
  function inputForColumn(column: string): WidgetName {
    const meta = recordColumns.value.find(c => c.name === column)
    if (!meta) return 'UInput'
    return columnFormInput({
      name: column,
      dataType: meta.dataType,
      foreignKey: recordRelations.value.find(r => r.sourceColumn === column) ?? null,
      checks: recordCatalog.value?.checkConstraints ?? [],
      input: recordPresentation(column)?.input,
      linkType: recordPresentation(column)?.linkType
    }).widget
  }

  return { recordTable, recordTableName, recordColumns, recordRelations, recordJunctions, recordPresentation, columnTitle, inputForColumn }
}
