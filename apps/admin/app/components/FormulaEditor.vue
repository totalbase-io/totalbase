<script setup lang="ts">
/**
 * Bindings v2's real authoring surface (BindingButton.vue's own Phase 4
 * note) - Monaco (already a project dependency: SqlEditor.vue/
 * JsonEditor.vue/JsonViewer.vue, same lazy-load/theme pattern reused
 * here rather than invented fresh) with a small custom language
 * ("totalbase-formula", registered once, module-level flag same as
 * defineAdminThemes' own `themesDefined`): syntax highlighting for
 * `{{column}}` tokens/operators/strings/numbers, and autocomplete for
 * both column names (triggered by `{{`) and the formula engine's own
 * function allowlist (`FORMULA_FUNCTION_SIGNATURES`, formula-engine.ts -
 * one list, never a second one hand-typed here that could drift).
 *
 * Deliberately NOT a general-purpose code editor - no folding/minimap/
 * line numbers (same trimmed-down chrome JsonEditor.vue already uses
 * for a single field's worth of text, not a full-page tool), and the
 * language/completion providers only ever SUGGEST text - Monaco itself
 * never executes anything; `evaluateFormula` (formula-engine.ts) is the
 * only thing that ever runs a formula, and only against jsep's own AST,
 * never Monaco's buffer directly.
 */
import type * as Monaco from 'monaco-editor'
import type { CatalogColumn } from '~/types/permission'
import { adminThemeName, defineAdminThemes } from '~/utils/monaco-theme'
import { FORMULA_FUNCTION_SIGNATURES } from '~/utils/formula-engine'

const props = withDefaults(defineProps<{
  modelValue: string
  columns?: CatalogColumn[]
  disabled?: boolean
  minHeight?: string
}>(), {
  columns: () => [],
  disabled: false,
  minHeight: '4.5rem'
})
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const LANGUAGE_ID = 'totalbase-formula'

/**
 * Monarch tokenizer - highlighting only, never parses for real (jsep/
 * formula-engine.ts own that). `{{column}}` as one token type, the
 * function allowlist as its own (case-sensitive, matching `evaluateNode`'s
 * own exact-name lookup), then the usual operator/string/number/
 * punctuation buckets.
 *
 * Guarded by asking MONACO ITSELF whether `LANGUAGE_ID` is already
 * registered (`m.languages.getLanguages()`), not a local module-level
 * flag - a flag here only guards against repeat calls within the SAME
 * evaluation of this module; Monaco's own language/provider registry is
 * a separate global that outlives a module reload (Vite HMR editing this
 * file, or any other reason this module re-evaluates), so a local flag
 * resets to false while Monaco still remembers the old registration -
 * the next mount then ADDS a second completion provider on top of the
 * first instead of skipping, and Monaco merges suggestions from every
 * provider registered for a language, hence duplicate entries in the
 * dropdown (one set per stale re-registration). Asking Monaco directly
 * survives that because it reflects reality, not this module's own
 * lifetime.
 */
function registerFormulaLanguage(m: typeof Monaco) {
  if (m.languages.getLanguages().some(l => l.id === LANGUAGE_ID)) return
  const functionNames = Object.keys(FORMULA_FUNCTION_SIGNATURES)

  m.languages.register({ id: LANGUAGE_ID })
  m.languages.setMonarchTokensProvider(LANGUAGE_ID, {
    functionNames,
    tokenizer: {
      root: [
        [/\{\{\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\}\}/, 'variable.predefined'],
        [/[a-zA-Z_][a-zA-Z0-9_]*(?=\s*\()/, { cases: { '@functionNames': 'keyword', '@default': 'identifier' } }],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/\d+(\.\d+)?/, 'number'],
        [/[+\-*/%!?:]|==|!=|===|!==|>=|<=|>|<|&&|\|\|/, 'operator'],
        [/[(),]/, 'delimiter']
      ]
    }
  })

  m.languages.registerCompletionItemProvider(LANGUAGE_ID, {
    triggerCharacters: ['{'],
    provideCompletionItems(model, position) {
      const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1)
      const word = model.getWordUntilPosition(position)
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn }

      // Right after `{{` (or `{{partial`) - offer column names only, closing the braces too.
      if (/\{\{\s*[a-zA-Z0-9_]*$/.test(line)) {
        return {
          suggestions: props.columns.map(c => ({
            label: c.name,
            kind: m.languages.CompletionItemKind.Field,
            detail: c.dataType,
            insertText: `${c.name}}}`,
            range
          }))
        }
      }
      // Otherwise - function names, from the SAME allowlist the evaluator itself uses.
      return {
        suggestions: functionNames.map(name => ({
          label: name,
          kind: m.languages.CompletionItemKind.Function,
          detail: FORMULA_FUNCTION_SIGNATURES[name],
          insertText: name,
          range
        }))
      }
    }
  })
}

const containerRef = ref<HTMLDivElement | null>(null)
let editor: Monaco.editor.IStandaloneCodeEditor | null = null
let monaco: typeof Monaco | null = null
const colorMode = useColorMode()

onMounted(async () => {
  // Loaded dynamically, same rationale as every other Monaco instance in
  // the admin (JsonEditor.vue's own doc comment) - the app already pays
  // this cost elsewhere, reusing it here is marginal, not a new one.
  monaco = await import('monaco-editor')
  if (!containerRef.value) return
  defineAdminThemes(monaco)
  registerFormulaLanguage(monaco)

  editor = monaco.editor.create(containerRef.value, {
    value: props.modelValue,
    language: LANGUAGE_ID,
    theme: adminThemeName(colorMode.value === 'dark' ? 'dark' : 'light'),
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    scrollBeyondLastLine: false,
    lineNumbers: 'off',
    folding: false,
    glyphMargin: false,
    lineDecorationsWidth: 8,
    lineNumbersMinChars: 0,
    wordWrap: 'on',
    readOnly: props.disabled,
    domReadOnly: props.disabled,
    quickSuggestions: { other: true, strings: true }
  })

  editor.onDidChangeModelContent(() => {
    emit('update:modelValue', editor!.getValue())
  })
})

/**
 * `BindingButton.vue`'s own Fields/Functions/Format sidebar - a real
 * Monaco edit (`executeEdits`) at the CURRENT selection/cursor, never a
 * plain-string append. This is why "click a Field while text is
 * selected" couldn't work before this existed: the old approach
 * mutated `draft` from OUTSIDE the editor, which only ever reaches
 * Monaco through `watch(() => props.modelValue, ...)`'s own
 * `editor.setValue(...)` below - a FULL buffer replace that always
 * resets the cursor to the start and drops any selection, regardless of
 * where the builder was actually working.
 *
 * After inserting, tries to auto-select the FIRST `"val1"` placeholder
 * (quotes included, so replacing it can never leave stray empty quotes
 * behind) - `FORMULA_FUNCTION_INSERT_TEMPLATES`'s own worked example
 * (`CONCATENATE("val1", "val2", "valN")`): a builder can click a Field
 * right after inserting a function template with no manual
 * double-click-to-select step first. Falls back to just placing the
 * cursor at the end of the inserted text when there's no such
 * placeholder (a plain Field/Format insert, most of the time).
 */
function insertAtCursor(text: string) {
  if (!editor || !monaco) return
  const model = editor.getModel()
  const selection = editor.getSelection()
  if (!model || !selection) return
  editor.executeEdits('insert', [{ range: selection, text, forceMoveMarkers: true }])
  const startOffset = model.getOffsetAt({ lineNumber: selection.startLineNumber, column: selection.startColumn })
  const placeholderIndex = text.indexOf('"val1"')
  const selectFrom = placeholderIndex !== -1 ? startOffset + placeholderIndex : startOffset + text.length
  const selectTo = placeholderIndex !== -1 ? selectFrom + '"val1"'.length : selectFrom
  const from = model.getPositionAt(selectFrom)
  const to = model.getPositionAt(selectTo)
  editor.setSelection(new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column))
  editor.focus()
}
defineExpose({ insertAtCursor })

watch(() => colorMode.value, (mode) => {
  monaco?.editor.setTheme(adminThemeName(mode === 'dark' ? 'dark' : 'light'))
})
watch(() => props.disabled, (disabled) => {
  editor?.updateOptions({ readOnly: disabled, domReadOnly: disabled })
})
watch(() => props.modelValue, (value) => {
  if (editor && editor.getValue() !== value) editor.setValue(value)
})

onBeforeUnmount(() => {
  editor?.dispose()
})
</script>

<template>
  <div
    ref="containerRef"
    class="w-full border border-default rounded-md overflow-hidden"
    :style="{ minHeight }"
  />
</template>
