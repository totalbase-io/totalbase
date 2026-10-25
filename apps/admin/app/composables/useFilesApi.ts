import type { FileNode } from '~/types/file'

export interface FolderNode {
  id: string
  parent: string | null
  name: string
  createdAt: string
  updatedAt: string
}

/**
 * Files and folders for every portal user (Security.md §9.3).
 * Read through the Data API (files / folders -
 * only the rows and columns the caller may read; a file's storage key
 * never comes out of it). Files are written through their own Data API
 * routes (upload, content, metadata, delete), folders as plain Data API
 * rows (the name rule is a PostgreSQL CHECK, the creator a trigger) - all
 * authorized by the same resolver. An administrator uses the same path
 * and bypasses permissions.
 */
export function useFilesApi() {
  const dataApi = useDataApi()
  const filesPath = dataApi.resourcePath('totalbase', 'files')
  const foldersPath = dataApi.resourcePath('totalbase', 'folders')
  const folderFromRow = (row: Record<string, unknown>): FolderNode => ({
    id: row.id as string,
    parent: (row.parent ?? null) as string | null,
    name: row.name as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  })

  return {
    listFolders: async (): Promise<FolderNode[]> =>
      (await dataApi.getAll<Record<string, unknown>>(foldersPath, { order_by: 'name' })).map(folderFromRow),
    // Every file, by name - the workflow step modals' file pickers. A column the caller may not read is omitted,
    // not null - default the ones the screen calls methods on.
    listFiles: async (): Promise<FileNode[]> =>
      (await dataApi.getAll<Partial<FileNode>>(dataApi.resourcePath('totalbase', 'files'), { order_by: 'name' })).map(row => ({ mime_type: '', tags: [], metadata: {}, ...row }) as FileNode),
    /**
     * One page of a folder's files (`folder` null: the root's), by name, with the total - the Data API's own
     * `limit`/`offset`/`count`, never the whole table: the page lists what it shows. `search` is the Data API's
     * (`ILIKE` over the readable text columns - the name, the description, the type).
     */
    listFilesPage: async (query: { folder: string | null, search?: string, limit: number, offset: number }): Promise<{ files: FileNode[], total: number }> => {
      const res = await dataApi.get<Partial<FileNode>[]>(dataApi.resourcePath('totalbase', 'files'), {
        ...(query.folder === null ? { 'where[folder][_null]': true } : { 'where[folder][_eq]': query.folder }),
        ...(query.search?.trim() ? { search: query.search.trim() } : {}),
        order_by: 'name',
        limit: query.limit,
        offset: query.offset,
        count: true
      })
      return {
        // A column the caller may not read is omitted, not null - default the ones the screen calls methods on.
        files: res.data.map(row => ({ mime_type: '', tags: [], metadata: {}, ...row }) as FileNode),
        total: (res.meta as { count?: number } | undefined)?.count ?? res.data.length
      }
    },
    createFolder: async (body: { parent: string | null, name: string }): Promise<FolderNode> =>
      folderFromRow((await dataApi.post<Record<string, unknown>>(foldersPath, { data: { ...(body.parent && { parent: body.parent }), name: body.name.trim() } })).data),
    renameFolder: async (id: string, name: string): Promise<FolderNode> =>
      folderFromRow((await dataApi.patch<Record<string, unknown>>(`${foldersPath}/${id}`, { data: { name: name.trim() } })).data),
    deleteFolder: async (id: string): Promise<void> => {
      await dataApi.del(`${foldersPath}/${id}`)
    },
    upload: async (form: FormData): Promise<FileNode> => (await dataApi.post<FileNode>(filesPath, form)).data,
    // JSON bodies carry the `{ data }` envelope (Data_API.md §2.5); multipart goes as is.
    replaceContent: async (id: string, body: FormData | { content: string }): Promise<FileNode> =>
      (await dataApi.put<FileNode>(`${filesPath}/${id}/content`, body instanceof FormData ? body : { data: body })).data,
    /** Metadata, and rename (`name`) / move (`folder`, null = root) - Administration.md §10.12. */
    updateMetadata: async (id: string, patch: { visibility?: 'PRIVATE' | 'PUBLIC', description?: string | null, tags?: string[], name?: string, folder?: string | null }): Promise<FileNode> =>
      (await dataApi.patch<FileNode>(`${filesPath}/${id}`, { data: patch })).data,
    remove: async (id: string): Promise<void> => {
      await dataApi.del(`${filesPath}/${id}`)
    },
    /** A file's content and stored name (its Content-Disposition) - READ on that file, like every other route here. */
    download: async (id: string): Promise<{ blob: Blob, filename: string }> => {
      const response = await $fetch.raw(`/api${filesPath}/${id}`, {
        baseURL: '',
        responseType: 'blob'
      })
      const disposition = response.headers.get('content-disposition') ?? ''
      const encoded = /filename="([^"]*)"/.exec(disposition)?.[1]
      return { blob: response._data as Blob, filename: encoded ? decodeURIComponent(encoded) : id }
    }
  }
}
