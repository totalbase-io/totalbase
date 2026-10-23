import { fileRequests, retryingRateLimit } from '~/utils/rate-limit'

/**
 * An image from Files for an <img> (Administration.md §10): a
 * PRIVATE file answers only a request with the viewer's bearer token, which
 * an <img src> can't send - so it is fetched with it, once, and shown as a
 * blob: URL. Shared by every caller (the Files screen, cards, kanban, a
 * tree's avatars, a file field's preview): one fetch per file and size,
 * through the shared limiter (a few at a time, never one per row at once),
 * kept for the session up to a cap - the oldest released (revoked) beyond
 * it, but never one asked for in the last moments: the images on screen
 * are asked for on every render, and dropping one of them would fetch it
 * again, drop another, and so on without end.
 *
 * A caller that may show many (a card per row) passes a deferred reference
 * (`deferredFileSrc`) and lets FileImage.vue resolve it once on screen.
 */
const urls = reactive(new Map<string, string>())
const loading = new Set<string>()
const failed = new Set<string>()
/** When each URL was last asked for - what the cap spares. */
const lastAsked = new Map<string, number>()
const CAP = 300
const SPARED_MS = 30_000
const DEFERRED_PREFIX = 'tb-file:'

function remember(key: string, url: string) {
  urls.set(key, url)
  if (urls.size <= CAP) return
  const now = Date.now()
  for (const [oldest, oldUrl] of urls) {
    if (urls.size <= CAP) break
    if (now - (lastAsked.get(oldest) ?? 0) < SPARED_MS) continue
    URL.revokeObjectURL(oldUrl)
    urls.delete(oldest)
    lastAsked.delete(oldest)
  }
}

/** A file image to fetch only once it's on screen: FileImage.vue (or resolveFileSrc) turns it into the blob: URL. */
export function deferredFileSrc(id: string, width?: number): string {
  return `${DEFERRED_PREFIX}${width ?? ''}:${id}`
}

export function useFileObjectUrl() {
  const session = useSession()

  async function load(key: string, id: string, width: number | undefined) {
    loading.add(key)
    try {
      const response = await fileRequests.run(() => retryingRateLimit(true, () => $fetch.raw(`/api/totalbase/table/files/${id}${width ? `?width=${width}&fit=cover` : ''}`, {
        baseURL: '',
        responseType: 'blob',
        headers: session.token.value ? { Authorization: `Bearer ${session.token.value}` } : undefined
      })))
      remember(key, URL.createObjectURL(response._data as Blob))
    } catch {
      // Gone, or not readable by this viewer: the caller shows its empty state - never retried in a loop.
      failed.add(key)
    } finally {
      loading.delete(key)
    }
  }

  /**
   * The blob: URL of file `id` (scaled to `width` when given), or undefined
   * while it loads - reactive: whatever renders it updates when it arrives.
   */
  function fileObjectUrl(id: string | null | undefined, width?: number): string | undefined {
    if (!id) return undefined
    const key = width ? `${id}@${width}` : id
    lastAsked.set(key, Date.now())
    const url = urls.get(key)
    if (url) return url
    if (!loading.has(key) && !failed.has(key) && import.meta.client) void load(key, id, width)
    return undefined
  }

  /** An image slot's src: a deferred file reference fetched now, anything else as it is. */
  function resolveFileSrc(src: string | null | undefined): string | undefined {
    if (!src?.startsWith(DEFERRED_PREFIX)) return src || undefined
    const rest = src.slice(DEFERRED_PREFIX.length)
    const separator = rest.indexOf(':')
    const width = Number(rest.slice(0, separator)) || undefined
    return fileObjectUrl(rest.slice(separator + 1), width)
  }

  /** Drops what is kept of file `id` (every size) - its content changed under the same id. */
  function forgetFile(id: string) {
    for (const key of [...urls.keys(), ...failed]) {
      if (key !== id && !key.startsWith(`${id}@`)) continue
      const url = urls.get(key)
      if (url) URL.revokeObjectURL(url)
      urls.delete(key)
      failed.delete(key)
      lastAsked.delete(key)
    }
  }

  return { fileObjectUrl, resolveFileSrc, forgetFile }
}
