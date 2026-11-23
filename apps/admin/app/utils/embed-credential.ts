/**
 * The credential an embed page uses (Dashboards.md §9.5), from its own address: a link's path is its credential;
 * a signed embed's token - in the fragment - is used only when it names the embed the path does. Framing is allowed
 * by the path's embed (`frame-ancestors`), so a token for another embed behind it would show that one on a site its
 * own `origins` leave out. `''` when the address holds no credential this page may use.
 */
export function embedCredentialFor(key: string, fragment: string): string {
  if (key.startsWith('tbe_')) return key
  let token: string
  try {
    token = decodeURIComponent(fragment.replace(/^#/, ''))
  } catch {
    return ''
  }
  // The drawer's preview: framed by TotalBase only, whatever its token says.
  if (key === 'preview') return token
  try {
    const payload = JSON.parse(atob((token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/'))) as { resource?: { embed?: unknown } }
    return payload.resource?.embed === key ? token : ''
  } catch {
    return ''
  }
}
