// Monaco needs its web workers wired up before the editor is created.
// SQL has no dedicated Monaco worker (unlike json/css/html/ts) - the
// generic editor worker covers tokenizing/basic features for it. JSON
// does have one, and it's not optional: as soon as monaco-editor's JSON
// language contribution is registered (just importing the package pulls
// it in), any model with languageId 'json' - JsonViewer's - triggers
// jsonMode's DiagnosticsAdapter, which calls createWebWorker for
// validation. Without a matching `label` case below, Monaco falls back
// to its AMD-style loadForeignModule path to fetch the worker script,
// which needs `getWorkerUrl`/a global `require` we don't set up (we load
// workers as Vite `?worker` modules, not AMD) - it throws deep inside
// FileAccessImpl instead of failing gracefully.
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
// CSS too, the same way: Settings > Appearance edits custom CSS in Monaco.
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import TypeScriptWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

export default defineNuxtPlugin(() => {
  self.MonacoEnvironment = {
    getWorker(_workerId, label) {
      if (label === 'json') return new JsonWorker()
      if (label === 'css') return new CssWorker()
      if (label === 'javascript' || label === 'typescript') return new TypeScriptWorker()
      return new EditorWorker()
    }
  }
  // Disposing an editor mid-request (a drawer closing while a hover or a
  // completion is pending) rejects Monaco's own promise with its
  // CancellationError, which nobody awaits - it's not a failure, so it
  // doesn't surface as an uncaught rejection.
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason as { name?: unknown, message?: unknown } | null
    if (reason?.name === 'Canceled' && reason.message === 'Canceled') event.preventDefault()
  })
})
