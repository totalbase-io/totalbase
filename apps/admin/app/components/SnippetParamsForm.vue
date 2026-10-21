<script setup lang="ts">
/**
 * A snippet's questions (the snippet catalog's `params`,
 * DataViews.md §11.2), answered from what the
 * page has: its variables of the right kind, its named widgets exposing the
 * right method, the App's DataViews. Recursive - "Ask for confirmation,
 * then…" asks for another snippet and its own questions.
 */
import { SNIPPET_NAMES, snippetDefaults, snippetDefinition, widgetDefinition, type SnippetName, type SnippetParam, type SnippetParams, type WidgetName } from '@totalbase/tb-catalog'
import { useDesignerCatalogText } from '~/utils/designer-catalog-text'

export interface SnippetContext {
  variables: readonly { name: string, kind: string }[]
  /** Named widgets - `dataview.controls.<name>`. */
  controls: readonly { name: string, widget: WidgetName }[]
  hasRecord: boolean
  /** The App's DataViews, by slug. */
  dataviews: readonly { label: string, value: string }[]
}

const props = defineProps<{ name: SnippetName, context: SnippetContext }>()
const params = defineModel<SnippetParams>({ required: true })

const { t } = useI18n()
const cat = useDesignerCatalogText()
/** Its params with their texts in the UI's language. */
const entries = computed(() => (Object.entries(snippetDefinition(props.name).params) as [string, SnippetParam][])
  .map(([key, param]): [string, SnippetParam] => [key, {
    ...param,
    label: cat.snippetParamLabel(props.name, key, param.label),
    description: param.description === undefined ? undefined : cat.snippetParamDescription(props.name, key, param.description),
    ...(param.editor === 'select' ? { options: param.options.map(o => ({ value: o.value, label: cat.snippetOptionLabel(props.name, key, o.value, o.label) })) } : {})
  } as SnippetParam]))
function stringOf(key: string): string | undefined {
  const value = params.value[key]
  return typeof value === 'string' ? value : undefined
}
function set(key: string, value: unknown) {
  params.value = { ...params.value, [key]: value }
}
function optionsFor(param: SnippetParam): string[] {
  if (param.editor === 'variable') return props.context.variables.filter(v => v.kind === param.kind).map(v => v.name)
  if (param.editor === 'control') return props.context.controls.filter(c => widgetDefinition(c.widget).expose?.includes(param.method)).map(c => c.name)
  return []
}
function emptyHint(param: SnippetParam): string | undefined {
  if (param.editor === 'variable' && optionsFor(param).length === 0) return t('designer.snippetParamsForm.noVariable', { kind: param.kind === 'CALL' ? t('designer.snippetParamsForm.kinds.call') : param.kind === 'RESOURCE' ? t('designer.snippetParamsForm.kinds.resource') : t('designer.snippetParamsForm.kinds.value') })
  if (param.editor === 'control' && optionsFor(param).length === 0) return t('designer.snippetParamsForm.noControl')
  return param.description
}
/** What "then" can run: any snippet this page can use, but not another confirmation. */
const nestable = computed(() => SNIPPET_NAMES
  .filter(n => n !== 'confirmThen' && (snippetDefinition(n).requires !== 'record' || props.context.hasRecord))
  .map(n => ({ label: cat.snippetLabel(n, snippetDefinition(n).label), value: n })))
function nested(key: string): { snippet?: SnippetName, params: SnippetParams } {
  return (params.value[key] as { snippet?: SnippetName, params: SnippetParams } | undefined) ?? { params: {} }
}
function setNested(key: string, snippet: SnippetName) {
  set(key, { snippet, params: snippetDefaults(snippet) })
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <template
      v-for="[key, param] in entries"
      :key="key"
    >
      <UFormField
        v-if="param.editor === 'snippet'"
        :label="param.label"
        :description="param.description"
      >
        <USelectMenu
          :model-value="nested(key).snippet"
          :items="nestable"
          value-key="value"
          class="w-full"
          @update:model-value="setNested(key, $event as SnippetName)"
        />
        <div
          v-if="nested(key).snippet"
          class="mt-3 border-l-2 border-default pl-4"
        >
          <SnippetParamsForm
            :name="nested(key).snippet!"
            :context="context"
            :model-value="nested(key).params"
            @update:model-value="set(key, { snippet: nested(key).snippet, params: $event })"
          />
        </div>
      </UFormField>
      <USwitch
        v-else-if="param.editor === 'boolean'"
        :model-value="params[key] === true"
        :label="param.label"
        :description="param.description"
        @update:model-value="set(key, $event)"
      />
      <UFormField
        v-else
        :label="param.label"
        :required="'required' in param && param.required"
        :description="emptyHint(param)"
      >
        <USelect
          v-if="param.editor === 'select'"
          :model-value="stringOf(key)"
          :items="param.options.map(o => ({ label: o.label, value: o.value }))"
          class="w-full"
          @update:model-value="set(key, $event)"
        />
        <USelectMenu
          v-else-if="param.editor === 'variable' || param.editor === 'control'"
          :model-value="stringOf(key)"
          :items="optionsFor(param)"
          :disabled="optionsFor(param).length === 0"
          class="w-full font-mono"
          @update:model-value="set(key, $event)"
        />
        <USelectMenu
          v-else-if="param.editor === 'dataview'"
          :model-value="stringOf(key)"
          :items="context.dataviews as { label: string, value: string }[]"
          value-key="value"
          class="w-full"
          @update:model-value="set(key, $event)"
        />
        <UInput
          v-else
          :model-value="stringOf(key) ?? ''"
          class="w-full"
          @update:model-value="set(key, $event)"
        />
      </UFormField>
    </template>
  </div>
</template>
