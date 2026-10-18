/**
 * An image from Files for an <img> (Specification_Administration.md §10): a
 * PRIVATE file answers only a request with the viewer's bearer token, which
 * an <img src> can't send - so it is fetched with it, once, and shown as a
 * blob: URL. Shared by every caller (cards, kanban, a file field's preview):
 * one fetch per file and size, kept for the session up to a cap - the
 * oldest ones released (revoked) beyond it.
 */
const urls = reactive(new Map<string, string>())
const loading = new Set<string>()
const failed = new Set<string>()
const CAP = 300

function remember(key: string, url: string) {
  urls.set(key, url)
  while (urls.size > CAP) {
    const [oldest] = urls.keys()
    if (oldest === undefined) break
    URL.revokeObjectURL(urls.get(oldest)!)
    urls.delete(oldest)
  }
}

export function useFileObjectUrl() {
  const session = useSession()

  async function load(key: string, id: string, width: number | undefined) {
    loading.add(key)
    try {
      const response = await $fetch.raw(`/api/totalbase/table/files/${id}${width ? `?width=${width}&fit=cover` : ''}`, {
        baseURL: '',
        responseType: 'blob',
        headers: session.token.value ? { Authorization: `Bearer ${session.token.value}` } : undefined
      })
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
    const url = urls.get(key)
    if (url) return url
    if (!loading.has(key) && !failed.has(key) && import.meta.client) void load(key, id, width)
    return undefined
  }

  return { fileObjectUrl }
}
