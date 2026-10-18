// The Workflows editor's view of the operation catalog (Specification_Workflows.md
// §5.25): the catalog itself - every step, its group, icon, ports and
// configuration shape - is `OPERATION_CATALOG` in @totalbase/tb-catalog, the
// one the server checks saves and publishes against. This module only puts it
// in the UI's language. A plain module, not <script setup> (see
// workflow-triggers.ts's own doc comment on why).

/**
 * The catalog in the UI's language (Specification_Admin_UI.md §14): each
 * operation's label and description through `workflows.catalog.operations.
 * <type>.label|description` (the type without its `totalbase.` prefix), each
 * group through `workflows.catalog.groups.<group>` - the catalog's English
 * stays the fallback.
 */
export function useOperationCatalogText() {
  const text = useCatalogText()
  const operationKey = (type: string) => `workflows.catalog.operations.${type.replace(/^totalbase\./, '')}`
  return {
    operationTitle: (type: string, english: string) => text(`${operationKey(type)}.label`, english),
    operationDescription: (type: string, english: string) => text(`${operationKey(type)}.description`, english),
    groupLabel: (group: string, english: string) => text(`workflows.catalog.groups.${group}`, english)
  }
}
