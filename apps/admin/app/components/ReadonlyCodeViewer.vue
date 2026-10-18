<script setup lang="ts">
import type * as Monaco from 'monaco-editor'

const props = withDefaults(defineProps<{
  code: string
  language?: string
}>(), {
  language: 'sql'
})

const containerRef = ref<HTMLDivElement | null>(null)
let editor: Monaco.editor.IStandaloneCodeEditor | null = null
let monaco: typeof Monaco | null = null

const colorMode = useColorMode()

onMounted(async () => {
  // Same lazy-load rationale as SqlEditor.vue - Monaco is only fetched when
  // a panel that actually needs it is opened.
  monaco = await import('monaco-editor')
  if (!containerRef.value) return

  editor = monaco.editor.create(containerRef.value, {
    value: props.code,
    language: props.language,
    theme: colorMode.value === 'dark' ? 'vs-dark' : 'vs',
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    readOnly: true,
    domReadOnly: true,
    scrollBeyondLastLine: false,
    lineNumbers: 'off',
    folding: false
  })
})

watch(() => colorMode.value, (mode) => {
  monaco?.editor.setTheme(mode === 'dark' ? 'vs-dark' : 'vs')
})

watch(() => props.code, (value) => {
  if (editor && editor.getValue() !== value) editor.setValue(value)
})

onBeforeUnmount(() => {
  editor?.dispose()
})
</script>

<template>
  <div
    ref="containerRef"
    class="w-full h-64 border border-default rounded-lg overflow-hidden"
  />
</template>
