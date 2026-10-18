<script setup lang="ts">
import type * as Monaco from 'monaco-editor'
import { adminThemeName, defineAdminThemes } from '~/utils/monaco-theme'

// A full-size JS/TS code editor - sibling of JsonEditor.vue (same
// shared theme/lazy-load approach) but for a DataView's own controller
// code, so line numbers/folding stay on (unlike JsonEditor's compact,
// single-field-value use case).
const props = withDefaults(defineProps<{
  modelValue: string
  language?: string
  minHeight?: string
  disabled?: boolean
}>(), {
  language: 'javascript',
  minHeight: '24rem',
  disabled: false
})
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const containerRef = ref<HTMLDivElement | null>(null)
let editor: Monaco.editor.IStandaloneCodeEditor | null = null
let monaco: typeof Monaco | null = null

const colorMode = useColorMode()

onMounted(async () => {
  // Loaded dynamically so Monaco (a few MB) is only fetched once this
  // editor actually mounts - same rationale as JsonEditor.vue/SqlEditor.vue.
  monaco = await import('monaco-editor')
  if (!containerRef.value) return
  defineAdminThemes(monaco)

  editor = monaco.editor.create(containerRef.value, {
    value: props.modelValue,
    language: props.language,
    theme: adminThemeName(colorMode.value === 'dark' ? 'dark' : 'light'),
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    scrollBeyondLastLine: false,
    readOnly: props.disabled,
    domReadOnly: props.disabled
  })

  editor.onDidChangeModelContent(() => {
    emit('update:modelValue', editor!.getValue())
  })
  if (pendingReveal !== null) {
    revealText(pendingReveal)
    pendingReveal = null
  }
})

/** A `revealText()` call made before Monaco finished loading - applied right after the editor is created. */
let pendingReveal: string | null = null
/**
 * Moves the cursor to the end of the line right after the first match of
 * `text` (e.g. `function onNoteChange(` - lands inside that function's
 * body), scrolls it into the middle of the view and focuses the editor.
 * Does nothing if `text` isn't there.
 */
function revealText(text: string) {
  if (!editor) {
    pendingReveal = text
    return
  }
  const model = editor.getModel()
  const match = model?.findMatches(text, false, false, true, null, false)[0]
  if (!model || !match) return
  const lineNumber = Math.min(match.range.startLineNumber + 1, model.getLineCount())
  const position = { lineNumber, column: model.getLineMaxColumn(lineNumber) }
  editor.setPosition(position)
  editor.revealLineInCenter(lineNumber)
  editor.focus()
}
/**
 * Inserts `text` at the cursor, indented like the line it lands on, as one
 * undoable edit - the Code's "Insert snippet". At the end of the code when
 * the editor never had the cursor.
 */
function insertAtCursor(text: string) {
  if (!editor || !monaco) return
  const model = editor.getModel()
  if (!model) return
  const position = editor.getPosition() ?? { lineNumber: model.getLineCount(), column: model.getLineMaxColumn(model.getLineCount()) }
  const current = model.getLineContent(position.lineNumber)
  const indent = /^\s*/.exec(current)![0]
  const indented = text.split('\n').map((line, i) => (i === 0 ? line : `${indent}${line}`)).join('\n')
  // On a blank line it goes right there; on a line with code, on new lines below it - never glued to it.
  const blank = current.trim() === ''
  const column = blank ? position.column : model.getLineMaxColumn(position.lineNumber)
  const range = new monaco.Range(position.lineNumber, column, position.lineNumber, column)
  editor.executeEdits('insert-snippet', [{ range, text: blank ? indented : `\n${indent}${indented}`, forceMoveMarkers: true }])
  editor.pushUndoStop()
  editor.focus()
}
defineExpose({ revealText, insertAtCursor })

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
    :style="{ height: minHeight }"
  />
</template>
