import type { ComputedRef, Ref } from 'vue'
import type { DesignerView } from '~/types/dataview'
import type CodeEditor from '~/components/CodeEditor.vue'
import type { SnippetContext } from '~/components/SnippetParamsForm.vue'
import { declaredFunctions, handlerName, handlerScaffold, handlerWithBody } from '~/utils/custom-code'
import { findDeclaration } from '~/utils/declares-function'

/**
 * A designed page's Code (CustomDesigner.vue's Code tab): the text, saved a
 * moment after a change; the functions it declares; its Reference; and how
 * handlers get into it - a scaffold for an event, or a snippet as its body
 * (DataViews.md §11.2) - with "Create handler" from the
 * inspector landing on the new function.
 */
export function useDesignerCode(options: {
  dataviewId: string
  initialCode: string
  /** The tab showing - a handler created elsewhere opens the Code tab on it. */
  view: Ref<DesignerView>
  /** What a snippet may refer to - the page's variables, controls, record and the other DataViews. */
  snippetContext: ComputedRef<SnippetContext>
}) {
  const api = useAdminApi()
  const code = ref(options.initialCode)
  let savedCode = code.value
  const codeAutosave = useAutosave(async () => {
    const next = code.value
    if (next === savedCode) return
    await api.post(`/dataviews/${options.dataviewId}/code`, { data: { code: next } })
    savedCode = next
  }, { delay: 600 })
  watch(code, (value) => {
    if (value !== savedCode) codeAutosave.schedule()
  })
  const codeFunctions = computed(() => declaredFunctions(code.value))
  /** The Code's Reference - what `dataview` holds; an example goes in at the cursor. */
  const referenceOpen = ref(false)
  function insertReference(example: string) {
    codeEditorRef.value?.insertAtCursor(example)
    referenceOpen.value = false
  }
  const codeEditorRef = ref<InstanceType<typeof CodeEditor> | null>(null)

  /** The Code tab, scrolled to function `name`'s declaration. */
  function showInCode(name: string) {
    options.view.value = 'code'
    const declaration = findDeclaration(code.value, name)
    if (declaration) nextTick(() => codeEditorRef.value?.revealText(declaration))
  }

  /** Appends a handler scaffold for `event` of `owner` and returns its name. */
  function scaffoldHandler(owner: string, event: string, what: string, payload: string | undefined): string {
    const name = handlerName(owner, event, codeFunctions.value)
    code.value = `${code.value.trimEnd()}\n${handlerScaffold(name, what, payload)}`
    return name
  }

  // --- Snippets: a new handler's body, or lines at the Code's cursor ---
  const snippetModal = reactive({
    open: false,
    mode: 'handler' as 'handler' | 'insert',
    subtitle: undefined as string | undefined,
    onConfirm: (_lines: string[] | null) => {}
  })
  function askSnippet(mode: 'handler' | 'insert', subtitle: string | undefined, onConfirm: (lines: string[] | null) => void) {
    Object.assign(snippetModal, { open: true, mode, subtitle, onConfirm })
  }
  /** A handler for `event` of `owner`: an empty one, or a snippet as its body - appended to the Code; resolves to its name. */
  function newHandler(owner: string, event: string, what: string, payload: string | undefined, done: (name: string) => void) {
    askSnippet('handler', what, (lines) => {
      const name = handlerName(owner, event, codeFunctions.value)
      code.value = `${code.value.trimEnd()}\n${lines ? handlerWithBody(name, what, payload, lines) : handlerScaffold(name, what, payload)}`
      done(name)
      showInCode(name)
    })
  }
  function insertSnippet() {
    askSnippet('insert', undefined, (lines) => {
      if (lines) codeEditorRef.value?.insertAtCursor(lines.join('\n'))
    })
  }

  return { code, codeAutosave, codeFunctions, referenceOpen, insertReference, codeEditorRef, showInCode, scaffoldHandler, snippetModal, askSnippet, newHandler, insertSnippet }
}
