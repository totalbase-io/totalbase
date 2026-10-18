export interface FileNode {
  id: string
  folder: string | null
  name: string
  extension: string
  mime_type: string
  size_bytes: number
  /** Admin API only - protected in the Data API. */
  storage_provider?: string
  storage_key?: string
  checksum: string
  width: number | null
  height: number | null
  visibility: 'PRIVATE' | 'PUBLIC'
  metadata: Record<string, unknown>
  description: string | null
  tags: string[]
  created_by: string | null
  updated_by: string | null
  created_at: string
  updated_at: string
}
