/**
 * Copies text to the clipboard. `navigator.clipboard` exists only in a secure context (HTTPS, or localhost): a
 * self-hosted instance served over plain HTTP has none, so there the selection is copied the older way. Rejects
 * when neither copies, so a caller's own error handling still runs.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Refused (no focus, a permission policy): the older way below may still work.
    }
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  try {
    // Deprecated, but the one copy a non-secure page has.
    if (!document.execCommand('copy')) throw new Error('Copy failed')
  } finally {
    area.remove()
  }
}
