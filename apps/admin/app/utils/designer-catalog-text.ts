import type { Composer } from 'vue-i18n'
import type { SnippetGroup, SnippetName, ValueType, VariableKind, WidgetGroup, WidgetName } from '@totalbase/tb-catalog'
import { catalogText } from '~/utils/catalog-text'

/**
 * The canvas catalogs' texts in the UI's language (Admin_UI.md
 * §14): the widget, variable and snippet catalogs of @totalbase/tb-catalog, read by
 * the Design form's palette, inspector, Variables panel and snippet wizards.
 * Each text's key is derived from its catalog key under `designer.catalog.*`;
 * the package's English is the fallback.
 *
 * A widget prop's text is looked up for that widget first
 * (`widgets.<Widget>.props.<prop>`), then shared by every widget whose prop
 * reads the same (`sharedProps.<prop>`) - the locale files keep a widget's own
 * key wherever its English differs from the shared one.
 */
type I18n = Pick<Composer, 't' | 'te'>

const ROOT = 'designer.catalog'

export function designerCatalogText(i18n: I18n) {
  const text = (key: string, english: string | undefined) => catalogText(i18n, `${ROOT}.${key}`, english)
  const propText = (widget: string, prop: string, field: 'label' | 'description', english: string | undefined) => {
    if (english === undefined) return ''
    const own = `${ROOT}.widgets.${widget}.props.${prop}.${field}`
    if (i18n.te(own)) return i18n.t(own)
    return text(`sharedProps.${prop}.${field}`, english)
  }
  return {
    widgetLabel: (widget: WidgetName | string, english: string) => text(`widgets.${widget}.label`, english),
    widgetDescription: (widget: WidgetName | string, english: string) => text(`widgets.${widget}.description`, english),
    /** A widget's prop - its own or a common one (COMMON_*_PROPS). */
    propLabel: (widget: WidgetName | string, prop: string, english: string) => propText(widget, prop, 'label', english),
    propDescription: (widget: WidgetName | string, prop: string, english: string | undefined) => propText(widget, prop, 'description', english),
    slotLabel: (widget: WidgetName | string, slot: string, english: string) => text(`widgets.${widget}.slots.${slot}`, english),
    emitLabel: (widget: WidgetName | string, emit: string, english: string) => text(`widgets.${widget}.emits.${emit}`, english),
    /** `widgetState()`'s entries: value, item, row. */
    widgetStateLabel: (state: string, english: string) => text(`widgetState.${state}.label`, english),
    widgetStateDescription: (state: string, english: string) => text(`widgetState.${state}.description`, english),
    groupLabel: (group: WidgetGroup | string, english: string) => text(`groups.${group}`, english),
    /** A section of a widget's own props (PROP_SECTIONS). */
    propSectionLabel: (section: string, english: string) => text(`propSections.${section}`, english),

    snippetLabel: (snippet: SnippetName | string, english: string) => text(`snippets.${snippet}.label`, english),
    snippetDescription: (snippet: SnippetName | string, english: string) => text(`snippets.${snippet}.description`, english),
    snippetParamLabel: (snippet: SnippetName | string, param: string, english: string) => text(`snippets.${snippet}.params.${param}.label`, english),
    snippetParamDescription: (snippet: SnippetName | string, param: string, english: string | undefined) => text(`snippets.${snippet}.params.${param}.description`, english),
    snippetOptionLabel: (snippet: SnippetName | string, param: string, value: string, english: string) => text(`snippets.${snippet}.params.${param}.options.${value}`, english),
    snippetGroupLabel: (group: SnippetGroup | string, english: string) => text(`snippetGroups.${group}`, english),

    variableKindLabel: (kind: VariableKind | string, english: string) => text(`variables.${kind}.label`, english),
    variableKindDescription: (kind: VariableKind | string, english: string) => text(`variables.${kind}.description`, english),
    variablePropLabel: (kind: VariableKind | string, prop: string, english: string) => text(`variables.${kind}.props.${prop}.label`, english),
    variablePropDescription: (kind: VariableKind | string, prop: string, english: string | undefined) => text(`variables.${kind}.props.${prop}.description`, english),
    variableStateLabel: (kind: VariableKind | string, state: string, english: string) => text(`variables.${kind}.state.${state}.label`, english),
    variableStateDescription: (kind: VariableKind | string, state: string, english: string) => text(`variables.${kind}.state.${state}.description`, english),
    variableMethodDescription: (kind: VariableKind | string, method: string, english: string) => text(`variables.${kind}.expose.${method}`, english),
    variableEmitLabel: (kind: VariableKind | string, emit: string, english: string) => text(`variables.${kind}.emits.${emit}`, english),
    valueTypeLabel: (type: ValueType | string, english: string) => text(`valueTypes.${type}.label`, english),
    valueTypeDescription: (type: ValueType | string, english: string) => text(`valueTypes.${type}.description`, english)
  }
}

export type DesignerCatalogText = ReturnType<typeof designerCatalogText>

/** `designerCatalogText` bound to the current language - for a component or composable. */
export function useDesignerCatalogText(): DesignerCatalogText {
  return designerCatalogText(useI18n())
}
