/**
 * Whether a DataView's `code` declares `name` at top level, the way
 * useDataViewController.ts resolves handlers by name - a `function name`
 * declaration (async or not) or a `const/let/var name =` binding. A static
 * check on purpose: the designer uses it only to warn about an event
 * pointing at a missing function, and must never execute the builder's
 * code just to find out (its top-level statements would run on every
 * keystroke). A declaration inside a comment or string can still match -
 * good enough for a warning, never used to decide what runs.
 */
export function declaresFunction(code: string, name: string): boolean {
  return findDeclaration(code, name) !== null
}

/** The exact text of `name`'s first declaration in `code` (e.g. `function onLoad(` or `const onLoad =`) - what the Code tab searches for to jump to it - or `null`. */
export function findDeclaration(code: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:\\bfunction\\s*\\*?\\s*${escaped}\\s*\\(|\\b(?:const|let|var)\\s+${escaped}\\s*=)`).exec(code)
  return match ? match[0] : null
}
