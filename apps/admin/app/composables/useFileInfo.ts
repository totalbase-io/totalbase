import type { FileNode } from '~/types/file'
import { fileRequests } from '~/utils/rate-limit'

/** What a file's cell needs of its row: its name and its type. */
export type FileInfo = Pick<FileNode, 'id' | 'name' | 'mime_type'>

/**
 * A file's row from Files (Administration.md §10) - its name and type - read once per file and
 * shared by every caller (a grid's file cells, many rows over few files). Undefined while it loads, null when it
 * can't be read (gone, or not this viewer's).
 *
 * The files asked for in the same moment (a grid's page of cells) are read in one Data API request
 * (`where[id][_in]`, the viewer's READ and row filter); one it doesn't answer - a PUBLIC file the viewer holds no
 * grant on, which its own route still serves - is then read alone, by its route.
 */
const infos = reactive(new Map<string, FileInfo | null>())
const loading = new Set<string>()
const queued = new Set<string>()
const BATCH = 100

export function useFileInfo() {
  const dataApi = useDataApi()

  async function loadOne(id: string) {
    try {
      // Through the limiter the files' images share: a grid of file cells asks a few at a time (utils/rate-limit.ts).
      infos.set(id, (await fileRequests.run(() => dataApi.get<FileNode>(`/totalbase/table/files/${id}/info`))).data)
    } catch {
      infos.set(id, null)
    } finally {
      loading.delete(id)
    }
  }

  async function flush() {
    const ids = [...queued]
    queued.clear()
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH)
      try {
        const { data } = await fileRequests.run(() => dataApi.get<FileInfo[]>(dataApi.resourcePath('totalbase', 'files'), {
          'where[id][_in]': batch.join(','),
          'fields': 'id,name,mime_type',
          'limit': BATCH
        }))
        for (const file of data) {
          infos.set(file.id, file)
          loading.delete(file.id)
        }
      } catch {
        // No READ on Files at all: each one by its route, below.
      }
      for (const id of batch) if (!infos.has(id)) void loadOne(id)
    }
  }

  function fileInfo(id: string | null | undefined): FileInfo | null | undefined {
    if (!id) return null
    if (infos.has(id)) return infos.get(id)
    if (!loading.has(id) && import.meta.client) {
      loading.add(id)
      // The cells rendered in this tick join one request.
      if (queued.size === 0) setTimeout(() => void flush(), 0)
      queued.add(id)
    }
    return undefined
  }

  return { fileInfo }
}
