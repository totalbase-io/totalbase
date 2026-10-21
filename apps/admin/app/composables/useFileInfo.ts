import type { FileNode } from '~/types/file'

/**
 * A file's row from Files (Administration.md §10) - its name and type - read once per file and
 * shared by every caller (a grid's file cells, many rows over few files). Undefined while it loads, null when it
 * can't be read (gone, or not this viewer's).
 */
const infos = reactive(new Map<string, FileNode | null>())
const loading = new Set<string>()

export function useFileInfo() {
  const dataApi = useDataApi()

  async function load(id: string) {
    loading.add(id)
    try {
      infos.set(id, (await dataApi.get<FileNode>(`/totalbase/table/files/${id}/info`)).data)
    } catch {
      infos.set(id, null)
    } finally {
      loading.delete(id)
    }
  }

  function fileInfo(id: string | null | undefined): FileNode | null | undefined {
    if (!id) return null
    if (infos.has(id)) return infos.get(id)
    if (!loading.has(id) && import.meta.client) void load(id)
    return undefined
  }

  return { fileInfo }
}
