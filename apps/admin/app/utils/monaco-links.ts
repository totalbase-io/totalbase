import type * as Monaco from 'monaco-editor'

let guarded = false

/** Whether a link in an editor may open: a web address only. */
export function isOpenableLink(href: string): boolean {
  return /^https?:\/\//i.test(href)
}

/**
 * Every Monaco editor's link opener, registered once (Admin_UI.md §1.1): a Ctrl+click on a link in a file's text or a
 * script opens an http(s) address in a new tab without access to this page, and nothing else - a `javascript:` or
 * `data:` link in someone's file would run on the admin's origin.
 */
export function guardMonacoLinks(monaco: typeof Monaco): void {
  if (guarded) return
  guarded = true
  monaco.editor.registerLinkOpener({
    open(resource) {
      const href = resource.toString(true)
      if (isOpenableLink(href)) window.open(href, '_blank', 'noopener,noreferrer')
      return true
    }
  })
}
