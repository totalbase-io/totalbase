const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const FILE_ID = new RegExp(`^${UUID}$`, 'i')
const FILE_PATH = new RegExp(`^/api/totalbase/table/files/(${UUID})$`, 'i')

/**
 * What an Image widget's `src` shows (DataViews.md §9.10): a file - by its id or its own path, the only thing read
 * with the viewer's token - or an https URL shown as it is; anything else nothing. A record's value of
 * `/admin/api/...` or `//elsewhere` is never fetched with the viewer's credentials.
 */
export function imageSource(src: unknown): { file: string } | { url: string } | null {
  const value = typeof src === 'string' ? src.trim() : ''
  const file = FILE_ID.test(value) ? value : FILE_PATH.exec(value)?.[1]
  if (file) return { file }
  return /^https:\/\//i.test(value) ? { url: value } : null
}
