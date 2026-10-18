import { FRAME_URL_TOKEN } from '@totalbase/tb-catalog'

/**
 * The URL an EXTERNALFRAME may mount, or null - a render-time guard, not
 * the validation (that is the server's `validateFrameUrl`, on every save):
 * an absolute https URL without credentials that isn't this app's own
 * origin. The frame's sandbox allows scripts + same-origin, which is only
 * safe for a cross-origin document (Specification_DataViews.md,
 * "EXTERNALFRAME security"), so a draft or stored URL failing this is never
 * rendered - also what gates the wizard's and settings' live preview.
 */
export function embeddableFrameUrl(raw: string | null | undefined): string | null {
  const text = raw?.trim()
  if (!text) return null
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null
  if (import.meta.client && url.origin === window.location.origin) return null
  return url.href
}

/**
 * A Frame widget's URL with its page values filled in (Specification_DataViews.md
 * §9.7): each `FRAME_URL_TOKEN` replaced by `valueOf(token)`, URL-encoded -
 * a value can't add a `/`, `?` or `#` of its own. Null when a value is
 * missing (no URL for this record yet) or the result isn't embeddable; the
 * site itself was fixed by the server's check when it was saved. `token`: the
 * tokens it fills - a page's, or a dashboard's (`DASHBOARD_FRAME_URL_TOKEN`).
 */
export function resolveFrameUrlTemplate(template: string | null | undefined, valueOf: (token: string) => unknown, token: string = FRAME_URL_TOKEN): string | null {
  const text = template?.trim()
  if (!text) return null
  let missing = false
  const filled = text.replace(new RegExp(token, 'g'), (match) => {
    const value = valueOf(match)
    if (value === null || value === undefined || value === '') {
      missing = true
      return ''
    }
    return encodeURIComponent(typeof value === 'object' ? JSON.stringify(value) : String(value))
  })
  return missing ? null : embeddableFrameUrl(filled)
}
