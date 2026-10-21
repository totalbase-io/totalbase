<script setup lang="ts">
import type { FolderNode } from '~/composables/useFilesApi'
import type { FileNode } from '~/types/file'
import { useApiErrorMessage } from '~/utils/api-error-message'
// Absolute dates/times in the user's zone and format (My account > Preferences).
const dates = useDateTimeFormat()
const { t } = useI18n()
const errorMessage = useApiErrorMessage()
const notifyError = useErrorToast()

interface FolderTreeNode extends FolderNode {
  children: FolderTreeNode[]
  depth: number
}

const ROOT_ID = 'root'

// One path for administrators and delegated users alike (useFilesApi.ts).
const filesApi = useFilesApi()
// Only what the caller's permissions on files allow (Security.md §9.3).
const canCreate = computed(() => session.can('files', 'CREATE'))
const canUpdate = computed(() => session.can('files', 'UPDATE'))
const canDelete = computed(() => session.can('files', 'DELETE'))
const toast = useToast()
const session = useSession()
const selectedFolderId = ref(ROOT_ID)
const creatingFolderParentId = ref<string | null>(null)
const editingFolderId = ref<string | null>(null)
const deletingFolderId = ref<string | null>(null)
const selectedFile = ref<FileNode | null>(null)
const isUploadOpen = ref(false)
const uploading = ref(false)
const uploadFiles = ref<File[]>([])
const rowSelection = ref<Record<string, boolean>>({})
const deleteTargets = ref<FileNode[]>([])
const deleteConfirmed = ref(false)
const deletingFiles = ref(false)
const savingDetails = ref(false)
const editDescription = ref('')
const editTags = ref<string[]>([])
const previewUrls = ref<Map<string, string>>(new Map())
const previewsLoading = ref<Set<string>>(new Set())
const thumbnailUrls = ref<Map<string, string>>(new Map())
const thumbnailsLoading = ref<Set<string>>(new Set())
const isEditorOpen = ref(false)
const editorFile = ref<FileNode | null>(null)
const editorContent = ref('')
const editorLoading = ref(false)
const editorSaving = ref(false)
const isImageEditorOpen = ref(false)
const imageEditorFile = ref<FileNode | null>(null)
const isDeleteOpen = computed({
  get: () => deleteTargets.value.length > 0,
  set: (open: boolean) => {
    if (!open) deleteTargets.value = []
  }
})

const { data: storedFolders, pending, error, refresh } = await useAsyncData(
  'files-folders-db',
  () => filesApi.listFolders(),
  { default: () => [] }
)

// The folder's files come a page at a time from the Data API (`limit`/
// `offset`/`count`, useFilesApi.listFilesPage) - the table shows one page
// and the pager the total, never the whole files table on the client. The
// search is the server's too, debounced like a grid's (useDebouncedRef).
const search = ref('')
const debouncedSearch = useDebouncedRef(search)
const prefs = usePagePreferences('files', { pageSize: 50 })
const page = ref(1)
// A different folder, search or page size makes the offset meaningless - back to page 1.
watch([selectedFolderId, debouncedSearch, () => prefs.pageSize], () => {
  page.value = 1
})
const { data: filesPage, pending: filesPending, error: filesError, refresh: refreshFiles } = await useAsyncData(
  'files-db',
  () => filesApi.listFilesPage({
    folder: selectedFolderId.value === ROOT_ID ? null : selectedFolderId.value,
    search: debouncedSearch.value,
    limit: prefs.pageSize,
    offset: (page.value - 1) * prefs.pageSize
  }),
  { watch: [selectedFolderId, debouncedSearch, page, () => prefs.pageSize], default: () => ({ files: [] as FileNode[], total: 0 }) }
)
/** The page shown - a row changed in place (rename, tags, visibility) is swapped here, replaceStoredFile. */
const pageFiles = computed(() => filesPage.value.files)
const filesTotal = computed(() => filesPage.value.total)

// Authors (created_by/updated_by) resolve through the shared user
// directory - only the ids of the files loaded, in one batch.
const directory = useUserDirectory()
watch(pageFiles, (files) => {
  directory.ensure(files.flatMap(file => [file.created_by, file.updated_by]))
}, { immediate: true })

const rootFolder = computed<FolderNode>(() => ({
  id: ROOT_ID,
  parent: null,
  name: '/',
  createdAt: '',
  updatedAt: ''
}))

const folders = computed<FolderNode[]>(() => [rootFolder.value, ...(storedFolders.value ?? [])])
const selectedFolder = computed(() => folders.value.find(folder => folder.id === selectedFolderId.value) ?? rootFolder.value)
const selectedFolderLabel = computed(() => selectedFolder.value.id === ROOT_ID ? t('content.files.tree.root') : selectedFolder.value.name)
const selectedFolderPath = computed(() => {
  const names: string[] = []
  let current: FolderNode | undefined = selectedFolder.value
  while (current && current.id !== ROOT_ID) {
    names.unshift(current.name)
    current = folders.value.find(folder => folder.id === current?.parent)
  }
  return `/${names.join('/')}`
})
/** The selection is the page's: another page, folder or search clears it (the watch below). */
const selectedFiles = computed(() => pageFiles.value.filter(file => rowSelection.value[file.id]))

watch([debouncedSearch, page], () => {
  rowSelection.value = {}
})
const fileColumns = computed(() => [
  { id: 'select', header: '', meta: { class: { th: 'w-10', td: 'w-10' } } },
  { accessorKey: 'name', header: t('common.name') },
  { accessorKey: 'extension', header: t('common.type') },
  { accessorKey: 'size_bytes', header: t('content.files.page.size') },
  { accessorKey: 'visibility', header: t('content.files.page.visibility') },
  { accessorKey: 'created_by', header: t('content.files.page.createdBy') },
  { accessorKey: 'updated_by', header: t('content.files.page.modifiedBy') },
  { accessorKey: 'updated_at', header: t('content.files.page.modified') }
])

const tree = computed<FolderTreeNode[]>(() => {
  const byParent = new Map<string | null, FolderNode[]>()
  for (const folder of folders.value) {
    const parent = folder.id === ROOT_ID ? null : (folder.parent ?? ROOT_ID)
    const siblings = byParent.get(parent) ?? []
    siblings.push(folder)
    byParent.set(parent, siblings)
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => {
      if (a.id === ROOT_ID) return -1
      if (b.id === ROOT_ID) return 1
      return a.name.localeCompare(b.name)
    })
  }
  const build = (parent: string | null, depth: number): FolderTreeNode[] =>
    (byParent.get(parent) ?? []).map(folder => ({
      ...folder,
      depth,
      children: build(folder.id, depth + 1)
    }))
  return build(null, 0)
})

function folderExists(parent: string | null, name: string, exceptId?: string): boolean {
  return (storedFolders.value ?? []).some(folder =>
    folder.id !== exceptId
    && (folder.parent ?? ROOT_ID) === (parent ?? ROOT_ID)
    && folder.name.toLowerCase() === name.toLowerCase()
  )
}

function cleanName(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function selectFolder(id: string) {
  selectedFolderId.value = id
  selectedFile.value = null
  rowSelection.value = {}
}

function startCreateFolder(parentId: string) {
  creatingFolderParentId.value = parentId
  editingFolderId.value = null
  deletingFolderId.value = null
}

async function createFolder(parentId: string, value: string) {
  const parentFolder = folders.value.find(folder => folder.id === parentId)
  if (!parentFolder) return
  const name = cleanName(value)
  if (!name) {
    toast.add({ title: t('content.files.page.folderNameRequired'), color: 'error' })
    return
  }
  if (name.includes('/')) {
    toast.add({ title: t('content.files.page.folderNameSlash'), color: 'error' })
    return
  }
  if (folderExists(parentFolder.id, name)) {
    toast.add({ title: t('content.files.page.folderExists'), color: 'error' })
    return
  }
  try {
    const folder = await filesApi.createFolder({
      parent: parentFolder.id === ROOT_ID ? null : parentFolder.id,
      name
    })
    await refresh()
    selectedFolderId.value = folder.id
    creatingFolderParentId.value = null
  } catch (err) {
    notifyError(err, t('content.files.page.createFolderError'))
  }
}

function startRenameFolder(id: string) {
  if (id === ROOT_ID) return
  creatingFolderParentId.value = null
  editingFolderId.value = id
  deletingFolderId.value = null
}

function confirmDeleteFolder(id: string) {
  if (id === ROOT_ID) return
  creatingFolderParentId.value = null
  editingFolderId.value = null
  deletingFolderId.value = id
}

async function renameFolder(id: string, value: string) {
  const current = folders.value.find(folder => folder.id === id)
  if (!current) return
  if (current.id === ROOT_ID) return
  const name = cleanName(value)
  if (!name) {
    toast.add({ title: t('content.files.page.folderNameRequired'), color: 'error' })
    return
  }
  if (name.includes('/')) {
    toast.add({ title: t('content.files.page.folderNameSlash'), color: 'error' })
    return
  }
  if (folderExists(current.parent, name, current.id)) {
    toast.add({ title: t('content.files.page.folderExists'), color: 'error' })
    return
  }
  try {
    await filesApi.renameFolder(id, name)
    await refresh()
    editingFolderId.value = null
  } catch (err) {
    notifyError(err, t('content.files.page.renameFolderError'))
  }
}

function descendantIds(folderId: string): Set<string> {
  const ids = new Set<string>([folderId])
  let changed = true
  while (changed) {
    changed = false
    for (const folder of storedFolders.value ?? []) {
      if (!ids.has(folder.id) && ids.has(folder.parent ?? ROOT_ID)) {
        ids.add(folder.id)
        changed = true
      }
    }
  }
  return ids
}

async function deleteFolder(id: string) {
  const current = folders.value.find(folder => folder.id === id)
  if (!current) return
  if (current.id === ROOT_ID) return
  const ids = descendantIds(current.id)
  try {
    await filesApi.deleteFolder(id)
    await refresh()
    if (ids.has(selectedFolderId.value)) selectedFolderId.value = current.parent ?? ROOT_ID
    if (ids.has(editingFolderId.value ?? '')) editingFolderId.value = null
    deletingFolderId.value = null
  } catch (err) {
    notifyError(err, t('content.files.page.deleteFolderError'))
  }
}

watch(pageFiles, (files) => {
  const visibleIds = new Set(files.map(file => file.id))
  rowSelection.value = Object.fromEntries(
    Object.entries(rowSelection.value).filter(([id]) => visibleIds.has(id))
  )
})

function formatDate(value: string): string {
  return dates.dateTime(value, { dateStyle: 'medium', timeStyle: 'short' })
}

function userLabel(id: string | null): string {
  return directory.label(id, '')
}

function fileIcon(file: FileNode): string {
  if (file.mime_type.startsWith('image/')) return 'i-lucide-image'
  if (file.mime_type === 'application/pdf') return 'i-lucide-file-text'
  if (file.mime_type.includes('zip') || file.mime_type.includes('tar')) return 'i-lucide-file-archive'
  if (file.mime_type.startsWith('text/')) return 'i-lucide-file-text'
  return 'i-lucide-file'
}

function openFile(file: FileNode) {
  selectedFile.value = file
  editDescription.value = file.description ?? ''
  editTags.value = [...file.tags]
  if (isImageFile(file)) loadDetailPreview(file)
}

async function refreshFilesList() {
  await refreshFiles()
}

function openUpload() {
  uploadFiles.value = []
  isUploadOpen.value = true
}

function onUploadFilesSelected(files: File[] | null | undefined) {
  uploadFiles.value = files ?? []
}

async function uploadFilesToServer() {
  if (uploadFiles.value.length === 0) {
    toast.add({ title: t('content.files.page.chooseFile'), color: 'error' })
    return
  }
  uploading.value = true
  let failures = 0
  try {
    for (const file of uploadFiles.value) {
      try {
        const form = new FormData()
        form.append('file', file)
        form.append('folder', selectedFolder.value.id === ROOT_ID ? '' : selectedFolder.value.id)
        await filesApi.upload(form)
      } catch {
        failures += 1
      }
    }
    await refreshFiles()
    const total = uploadFiles.value.length
    if (failures === 0) {
      toast.add({ title: t('content.files.page.uploaded', total), color: 'success' })
      isUploadOpen.value = false
    } else {
      toast.add({
        title: t('content.files.page.partialUploaded', { done: total - failures, total }),
        description: t('content.files.page.failed', { n: failures }),
        color: 'warning'
      })
    }
  } finally {
    uploading.value = false
  }
}

function isImageFile(file: FileNode): boolean {
  return file.mime_type.startsWith('image/')
}

function isTextEditable(file: FileNode): boolean {
  if (file.mime_type.startsWith('text/')) return true
  if (['application/json', 'application/xml', 'application/javascript', 'application/typescript', 'application/sql', 'application/x-yaml', 'application/yaml'].includes(file.mime_type)) return true
  return ['txt', 'md', 'markdown', 'html', 'htm', 'css', 'js', 'ts', 'json', 'xml', 'yaml', 'yml', 'sql', 'csv', 'log', 'env', 'toml', 'ini', 'conf'].includes(file.extension.toLowerCase())
}

function languageForFile(file: FileNode): string {
  const extension = file.extension.toLowerCase()
  if (extension === 'md' || extension === 'markdown') return 'markdown'
  if (extension === 'html' || extension === 'htm') return 'html'
  if (extension === 'css') return 'css'
  if (extension === 'js') return 'javascript'
  if (extension === 'ts') return 'typescript'
  if (extension === 'json') return 'json'
  if (extension === 'xml') return 'xml'
  if (extension === 'yaml' || extension === 'yml') return 'yaml'
  if (extension === 'sql') return 'sql'
  return 'plaintext'
}

async function openTextEditor(file: FileNode) {
  selectedFile.value = null
  editorFile.value = file
  editorContent.value = ''
  isEditorOpen.value = true
  editorLoading.value = true
  try {
    const response = await $fetch.raw(`/api/totalbase/table/files/${file.id}`, {
      baseURL: '',
      responseType: 'text',
      headers: session.token.value ? { Authorization: `Bearer ${session.token.value}` } : undefined
    })
    editorContent.value = String(response._data ?? '')
  } catch (err) {
    isEditorOpen.value = false
    toast.add({ title: t('content.files.page.loadFileError'), description: err instanceof Error ? err.message : undefined, color: 'error' })
  } finally {
    editorLoading.value = false
  }
}

function openImageEditor(file: FileNode) {
  imageEditorFile.value = file
  isImageEditorOpen.value = true
}

// A replaced file's content changed under the same id - any cached
// preview/thumbnail blob URL is now stale and must be re-fetched, not
// just have its underlying FileNode row swapped in.
function onImageReplaced(file: FileNode) {
  const previous = previewUrls.value.get(file.id)
  if (previous) URL.revokeObjectURL(previous)
  previewUrls.value.delete(file.id)
  const previousThumb = thumbnailUrls.value.get(file.id)
  if (previousThumb) URL.revokeObjectURL(previousThumb)
  thumbnailUrls.value.delete(file.id)
  replaceStoredFile(file)
  loadThumbnail(file)
  if (selectedFile.value?.id === file.id) loadDetailPreview(file)
}

function onImageSavedAs(_file: FileNode) {
  // A new row: the page it falls on is the server's to say.
  void refreshFiles()
}

async function saveTextEditor() {
  if (!editorFile.value) return
  editorSaving.value = true
  try {
    const data = await filesApi.replaceContent(editorFile.value.id, {
      content: editorContent.value
    })
    replaceStoredFile(data)
    editorFile.value = data
    toast.add({ title: t('content.files.page.fileSaved'), color: 'success' })
  } catch (err) {
    notifyError(err, t('content.files.editImage.saveError'))
  } finally {
    editorSaving.value = false
  }
}

// Requests an on-the-fly resized derivative (files.transforms.*,
// packages/files/src/transform-service.ts) rather than the full
// original - a thumbnail-sized `width` keeps row/slideover previews
// fast regardless of how large the source image actually is, and
// exercises the same transform pipeline the public content route
// supports (?width=&fit=&format=...).
async function loadPreview(file: FileNode, width: number, target: Map<string, string>, loading: Set<string>) {
  if (!isImageFile(file) || target.has(file.id) || loading.has(file.id)) return
  loading.add(file.id)
  try {
    const response = await $fetch.raw(`/api/totalbase/table/files/${file.id}?width=${width}&fit=cover`, {
      baseURL: '',
      responseType: 'blob',
      headers: session.token.value ? { Authorization: `Bearer ${session.token.value}` } : undefined
    })
    const blob = response._data as Blob
    target.set(file.id, URL.createObjectURL(blob))
  } catch {
    // Preview is optional; failed content fetch leaves the icon fallback.
  } finally {
    loading.delete(file.id)
  }
}

// Two sizes, two caches: a small thumbnail for the table row's icon
// slot, a larger one for the slideover's detail preview - reusing one
// size for both would mean either a blurry upscale in the slideover or
// a wastefully large fetch for every row icon.
const THUMBNAIL_WIDTH = 64
const DETAIL_PREVIEW_WIDTH = 640
function loadThumbnail(file: FileNode) {
  return loadPreview(file, THUMBNAIL_WIDTH, thumbnailUrls.value, thumbnailsLoading.value)
}
function loadDetailPreview(file: FileNode) {
  return loadPreview(file, DETAIL_PREVIEW_WIDTH, previewUrls.value, previewsLoading.value)
}

onBeforeUnmount(() => {
  for (const url of previewUrls.value.values()) URL.revokeObjectURL(url)
  for (const url of thumbnailUrls.value.values()) URL.revokeObjectURL(url)
})

// The thumbnails of the page shown - one fetch per image row on the
// page, never of the whole folder: the page is what is visible.
watch(pageFiles, (files) => {
  for (const file of files) {
    if (isImageFile(file)) loadThumbnail(file)
  }
}, { immediate: true })

function replaceStoredFile(file: FileNode) {
  filesPage.value = { ...filesPage.value, files: pageFiles.value.map(current => current.id === file.id ? file : current) }
  if (selectedFile.value?.id === file.id) selectedFile.value = file
}

async function toggleVisibility(file: FileNode) {
  try {
    const data = await filesApi.updateMetadata(file.id, {
      visibility: file.visibility === 'PUBLIC' ? 'PRIVATE' : 'PUBLIC'
    })
    replaceStoredFile(data)
  } catch (err) {
    notifyError(err, t('content.files.page.visibilityError'))
  }
}

async function saveFileDetails() {
  if (!selectedFile.value) return
  savingDetails.value = true
  try {
    const data = await filesApi.updateMetadata(selectedFile.value.id, {
      description: editDescription.value.trim() === '' ? null : editDescription.value.trim(),
      tags: editTags.value
    })
    replaceStoredFile(data)
    editDescription.value = data.description ?? ''
    editTags.value = [...data.tags]
    toast.add({ title: t('content.files.page.fileUpdated'), color: 'success' })
  } catch (err) {
    notifyError(err, t('content.files.page.updateError'))
  } finally {
    savingDetails.value = false
  }
}

// --- Rename and move (Administration.md §10.12) - the same
// metadata PATCH, so the same grants decide: UPDATE, field grants on
// name/folder, the row filter before and after. Rename is one field
// anchored to its button (a popover); Move picks a folder for one file or
// the whole selection (a small modal). ---
function folderPath(id: string | null): string {
  if (!id) return t('content.files.tree.root')
  const names: string[] = []
  let current = folders.value.find(folder => folder.id === id)
  while (current && current.id !== ROOT_ID) {
    names.unshift(current.name)
    const parent: string | null = current.parent
    current = folders.value.find(folder => folder.id === (parent ?? ROOT_ID))
  }
  return `/${names.join('/')}`
}
const folderOptions = computed(() => [
  { label: t('content.files.tree.root'), value: ROOT_ID },
  ...(storedFolders.value ?? []).map(folder => ({ label: folderPath(folder.id), value: folder.id })).sort((a, b) => a.label.localeCompare(b.label))
])

const renameOpen = ref(false)
const renameDraft = ref('')
const renaming = ref(false)
watch(renameOpen, (open) => {
  if (open && selectedFile.value) renameDraft.value = selectedFile.value.name
})
async function renameFile() {
  if (!selectedFile.value) return
  renaming.value = true
  try {
    replaceStoredFile(await filesApi.updateMetadata(selectedFile.value.id, { name: renameDraft.value }))
    renameOpen.value = false
    toast.add({ title: t('content.files.page.renamed'), color: 'success' })
  } catch (err) {
    notifyError(err, t('content.files.page.renameError'))
  } finally {
    renaming.value = false
  }
}

const moveTargets = ref<FileNode[]>([])
const isMoveOpen = computed({
  get: () => moveTargets.value.length > 0,
  set: (open: boolean) => {
    if (!open) moveTargets.value = []
  }
})
const moveFolder = ref(ROOT_ID)
const moving = ref(false)
function openMove(targets: FileNode[]) {
  moveFolder.value = selectedFolder.value.id
  moveTargets.value = targets
}
async function confirmMove() {
  const targets = moveTargets.value
  const folder = moveFolder.value === ROOT_ID ? null : moveFolder.value
  moving.value = true
  let failures = 0
  let lastError: string | undefined
  for (const target of targets) {
    try {
      replaceStoredFile(await filesApi.updateMetadata(target.id, { folder }))
    } catch (err) {
      failures += 1
      lastError = err instanceof AdminApiError ? errorMessage(err) : undefined
    }
  }
  moving.value = false
  moveTargets.value = []
  // What moved left the folder on screen - re-read it rather than keep the rows in place.
  await refreshFiles()
  const where = folderPath(folder)
  if (failures === 0) {
    toast.add({ title: t('content.files.page.moved', { n: targets.length, where }, targets.length), color: 'success' })
    rowSelection.value = {}
  } else {
    toast.add({
      title: t('content.files.page.partialMoved', { done: targets.length - failures, total: targets.length }),
      description: targets.length === 1 ? lastError : t('content.files.page.failedRetry', { n: failures }),
      color: failures === targets.length ? 'error' : 'warning'
    })
  }
}

// --- Bulk visibility - a plain dropdown, not a modal: a binary,
// instantly-reversible toggle doesn't need the heavier tool (AGENTS.md
// §25 "Popover vs modal"). Same pattern as assets.vue's own bulk
// visibility action. ---
const bulkVisibilityWorking = ref(false)
async function bulkSetVisibility(visibility: 'PUBLIC' | 'PRIVATE') {
  const targets = selectedFiles.value
  bulkVisibilityWorking.value = true
  let failures = 0
  for (const target of targets) {
    try {
      const data = await filesApi.updateMetadata(target.id, { visibility })
      replaceStoredFile(data)
    } catch {
      failures += 1
    }
  }
  bulkVisibilityWorking.value = false
  if (failures === 0) {
    toast.add({ title: visibility === 'PUBLIC' ? t('content.files.page.madePublic', targets.length) : t('content.files.page.madePrivate', targets.length), color: 'success' })
    rowSelection.value = {}
  } else {
    toast.add({
      title: t('content.files.page.partialUpdated', { done: targets.length - failures, total: targets.length }),
      description: t('content.files.page.failedRetry', { n: failures }),
      color: 'warning'
    })
  }
}

// --- Bulk tags - merge (add to each file's existing tags) or replace
// (overwrite them outright), same as assets.vue. ---
const isBulkTagsOpen = ref(false)
const bulkTagsMode = ref<'merge' | 'replace'>('merge')
const BULK_TAGS_MODE_OPTIONS = computed(() => [
  { label: t('content.files.page.tagsMerge'), value: 'merge' as const },
  { label: t('content.files.page.tagsReplace'), value: 'replace' as const }
])
const bulkTagsDraft = ref<string[]>([])
const bulkTagging = ref(false)

function openBulkTags() {
  bulkTagsMode.value = 'merge'
  bulkTagsDraft.value = []
  isBulkTagsOpen.value = true
}

async function saveBulkTags() {
  const targets = selectedFiles.value
  bulkTagging.value = true
  let failures = 0
  for (const target of targets) {
    try {
      const tags = bulkTagsMode.value === 'merge'
        ? Array.from(new Set([...target.tags, ...bulkTagsDraft.value]))
        : [...bulkTagsDraft.value]
      const data = await filesApi.updateMetadata(target.id, { tags })
      replaceStoredFile(data)
    } catch {
      failures += 1
    }
  }
  bulkTagging.value = false
  isBulkTagsOpen.value = false
  if (failures === 0) {
    toast.add({ title: t('content.files.page.filesUpdated', targets.length), color: 'success' })
    rowSelection.value = {}
  } else {
    toast.add({
      title: t('content.files.page.partialUpdated', { done: targets.length - failures, total: targets.length }),
      description: t('content.files.page.failedRetry', { n: failures }),
      color: 'warning'
    })
  }
}

const downloading = ref(false)
async function downloadFile(file: FileNode) {
  downloading.value = true
  try {
    const { blob, filename } = await filesApi.download(file.id)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  } catch (err) {
    notifyError(err, t('content.files.page.downloadError'))
  } finally {
    downloading.value = false
  }
}

function openDeleteFiles(targets: FileNode[]) {
  deleteConfirmed.value = false
  deleteTargets.value = targets
}

async function confirmDeleteFiles() {
  deletingFiles.value = true
  let failures = 0
  try {
    for (const file of deleteTargets.value) {
      try {
        await filesApi.remove(file.id)
      } catch {
        failures += 1
      }
    }
    if (selectedFile.value && deleteTargets.value.some(file => file.id === selectedFile.value?.id)) {
      selectedFile.value = null
    }
    rowSelection.value = {}
    const total = deleteTargets.value.length
    deleteTargets.value = []
    await refreshFiles()
    toast.add({
      title: failures === 0 ? t('content.files.page.deleted', total) : t('content.files.page.partialDeleted', { done: total - failures, total }),
      color: failures === 0 ? 'success' : 'warning'
    })
  } finally {
    deletingFiles.value = false
  }
}

// Header: Refresh (PageHeader's "⋮" on a phone) and the bulk actions
// while files are selected.
const headerActions = computed<HeaderAction[]>(() => [
  { label: t('common.refresh'), icon: 'i-lucide-refresh-cw', iconOnly: true, loading: filesPending.value, onSelect: refreshFilesList }
])
const headerSelection = computed<HeaderSelection>(() => {
  const actions: HeaderAction[] = []
  if (canUpdate.value) {
    actions.push({
      label: t('content.files.page.visibility'),
      icon: 'i-lucide-eye',
      loading: bulkVisibilityWorking.value,
      children: [
        { label: t('content.files.page.makePublic'), icon: 'i-lucide-eye', onSelect: () => bulkSetVisibility('PUBLIC') },
        { label: t('content.files.page.makePrivate'), icon: 'i-lucide-eye-off', onSelect: () => bulkSetVisibility('PRIVATE') }
      ]
    })
    actions.push({ label: t('content.files.page.tags'), icon: 'i-lucide-tag', onSelect: openBulkTags })
    actions.push({ label: t('content.files.page.moveToFolder'), icon: 'i-lucide-folder-input', onSelect: () => openMove(selectedFiles.value) })
  }
  if (canDelete.value) {
    actions.push({ label: t('common.delete'), icon: 'i-lucide-trash-2', color: 'error', onSelect: () => openDeleteFiles(selectedFiles.value) })
  }
  return {
    count: selectedFiles.value.length,
    actions,
    onClear: () => {
      rowSelection.value = {}
    }
  }
})

// The folder tree's props and listeners - one object, since the tree
// renders in the aside (desktop) or the slideover (phone).
const isMobile = useIsMobile()
const foldersOpen = ref(false)
const folderTreeBindings = computed(() => ({
  tree: tree.value,
  pending: pending.value,
  error: error.value,
  selectedId: selectedFolder.value.id,
  editingId: editingFolderId.value,
  creatingParentId: creatingFolderParentId.value,
  deletingId: deletingFolderId.value,
  onSelect: (id: string) => {
    selectFolder(id)
    foldersOpen.value = false
  },
  onNewFolder: startCreateFolder,
  onUploadFile: (id: string) => {
    selectFolder(id)
    foldersOpen.value = false
    openUpload()
  },
  onRenameFolder: startRenameFolder,
  onConfirmDelete: confirmDeleteFolder,
  onDeleteFolder: deleteFolder,
  onCancelDelete: () => {
    deletingFolderId.value = null
  },
  onSaveCreate: createFolder,
  onCancelCreate: () => {
    creatingFolderParentId.value = null
  },
  onSaveRename: renameFolder,
  onCancelRename: () => {
    editingFolderId.value = null
  }
}))
</script>

<template>
  <div class="flex h-full min-h-0 bg-elevated/50">
    <!-- The folder tree: an aside on desktop, a slideover on a phone
    (opened from the header's folder button). -->
    <aside
      v-if="!isMobile"
      class="flex w-80 shrink-0 flex-col border-e border-default bg-default"
    >
      <SidebarHeader
        :title="t('content.files.page.title')"
        :subtitle="selectedFolderLabel"
        icon="i-lucide-files"
      />

      <div class="min-h-0 flex-1 overflow-auto p-2">
        <FilesFolderTree v-bind="folderTreeBindings" />
      </div>
    </aside>
    <USlideover
      v-else
      v-model:open="foldersOpen"
      side="left"
      :title="t('content.files.page.folders')"
      :description="selectedFolderLabel"
      :ui="{ content: 'max-w-sm' }"
    >
      <template #body>
        <FilesFolderTree v-bind="folderTreeBindings" />
      </template>
    </USlideover>

    <PageShell
      class="min-w-0 flex-1"
      :scroll="false"
    >
      <template #header>
        <PageHeader
          :title="t('content.files.page.title')"
          :description="selectedFolderPath"
          icon="i-lucide-files"
          :actions="headerActions"
          :selection="headerSelection"
        >
          <template #search>
            <HeaderSearch
              v-model="search"
              :placeholder="t('content.files.page.searchPlaceholder')"
              class="w-64"
            />
          </template>
          <UButton
            v-if="isMobile"
            icon="i-lucide-folder-tree"
            color="neutral"
            variant="ghost"
            :aria-label="t('content.files.page.folders')"
            @click="foldersOpen = true"
          />
          <UButton
            v-if="canCreate && selectedFiles.length === 0"
            icon="i-lucide-upload"
            :label="t('common.upload')"
            @click="openUpload"
          />
        </PageHeader>
      </template>

      <UAlert
        v-if="filesError"
        class="mt-4"
        color="error"
        variant="subtle"
        :title="t('content.files.page.loadError')"
        :description="filesError instanceof AdminApiError ? errorMessage(filesError) : undefined"
      />

      <div
        v-if="!filesError && !filesPending && filesTotal === 0"
        class="flex min-h-[420px] flex-1 flex-col items-center justify-center py-16 text-center"
      >
        <div class="flex size-12 items-center justify-center rounded-xl bg-elevated ring-1 ring-default">
          <UIcon
            name="i-lucide-folder-open"
            class="size-5 text-muted"
          />
        </div>
        <h2 class="mt-4 text-base font-semibold text-highlighted">
          {{ search.trim() ? t('content.files.page.noMatchTitle') : t('content.files.page.emptyTitle') }}
        </h2>
        <p class="mt-1 max-w-sm text-sm text-muted">
          {{ search.trim() ? t('content.files.page.noMatchDescription') : t('content.files.page.emptyDescription') }}
        </p>
        <UButton
          v-if="!search.trim() && canCreate"
          class="mt-4"
          icon="i-lucide-upload"
          :label="t('content.files.page.uploadFile')"
          @click="openUpload"
        />
      </div>

      <div
        v-else-if="!filesError"
        class="flex min-h-0 flex-1 flex-col py-3"
      >
        <div class="min-h-0 flex-1 overflow-x-auto">
          <UTable
            v-model:row-selection="rowSelection"
            sticky
            :data="pageFiles"
            :columns="fileColumns"
            :loading="filesPending"
            :get-row-id="(row: FileNode) => row.id"
            :on-select="(_event: Event, row: { original: FileNode }) => openFile(row.original)"
          >
            <template #select-header="{ table }">
              <UCheckbox
                :model-value="table.getIsSomePageRowsSelected() ? 'indeterminate' : table.getIsAllPageRowsSelected()"
                :aria-label="t('content.files.page.selectAll')"
                @update:model-value="(value: boolean | 'indeterminate') => table.toggleAllPageRowsSelected(value === true)"
                @click.stop
              />
            </template>
            <template #select-cell="{ row }">
              <UCheckbox
                :model-value="row.getIsSelected()"
                :aria-label="t('content.files.page.selectOne', { name: row.original.name })"
                @update:model-value="(value: boolean | 'indeterminate') => row.toggleSelected(value === true)"
                @click.stop
              />
            </template>
            <template #name-cell="{ row }">
              <div class="flex min-w-64 cursor-pointer items-center gap-3">
                <img
                  v-if="isImageFile(row.original) && thumbnailUrls.get(row.original.id)"
                  :src="thumbnailUrls.get(row.original.id)"
                  class="size-8 shrink-0 rounded-md border border-default object-cover"
                  alt=""
                  loading="lazy"
                >
                <div
                  v-else
                  class="flex size-8 shrink-0 items-center justify-center rounded-md border border-default bg-default"
                >
                  <UIcon
                    :name="fileIcon(row.original)"
                    class="size-4 text-muted"
                  />
                </div>
                <div class="min-w-0">
                  <p class="truncate text-sm font-medium text-highlighted">
                    {{ row.original.name }}
                  </p>
                  <p
                    v-if="row.original.description"
                    class="truncate text-xs text-muted"
                  >
                    {{ row.original.description }}
                  </p>
                </div>
              </div>
            </template>
            <template #extension-cell="{ row }">
              <span class="uppercase text-muted">{{ row.original.extension }}</span>
            </template>
            <template #size_bytes-cell="{ row }">
              {{ formatBytes(row.original.size_bytes) }}
            </template>
            <template #visibility-cell="{ row }">
              <button
                type="button"
                class="inline-flex"
                @click.stop="toggleVisibility(row.original)"
              >
                <UBadge
                  :color="row.original.visibility === 'PUBLIC' ? 'success' : 'warning'"
                  variant="subtle"
                  size="sm"
                  class="cursor-pointer"
                >
                  {{ row.original.visibility === 'PUBLIC' ? t('content.docs.endpoints.public') : t('content.files.page.private') }}
                </UBadge>
              </button>
            </template>
            <template #created_by-cell="{ row }">
              <span class="text-muted">{{ userLabel(row.original.created_by) }}</span>
            </template>
            <template #updated_by-cell="{ row }">
              <span class="text-muted">{{ userLabel(row.original.updated_by) }}</span>
            </template>
            <template #updated_at-cell="{ row }">
              <span class="text-muted">{{ formatDate(row.original.updated_at) }}</span>
            </template>
          </UTable>
        </div>
      </div>

      <template #footer>
        <TablePager
          v-model:page="page"
          v-model:page-size="prefs.pageSize"
          :total="filesTotal"
          :noun="t('content.files.pager.noun')"
          :plural="t('content.files.pager.plural')"
          :page-size-options="[25, 50, 100, 200]"
        />
      </template>
    </PageShell>

    <USlideover
      :open="selectedFile !== null"
      :title="selectedFile?.name"
      :description="t('content.files.page.properties')"
      :ui="{ content: 'max-w-md' }"
      @update:open="open => { if (!open) selectedFile = null }"
    >
      <template #body>
        <div
          v-if="selectedFile"
          class="flex flex-col gap-5"
        >
          <div class="flex aspect-video items-center justify-center overflow-hidden rounded-lg border border-default bg-default">
            <img
              v-if="isImageFile(selectedFile) && previewUrls.get(selectedFile.id)"
              :src="previewUrls.get(selectedFile.id)"
              class="max-h-full max-w-full object-contain"
              alt=""
            >
            <UIcon
              v-else-if="isImageFile(selectedFile) && previewsLoading.has(selectedFile.id)"
              name="i-lucide-loader-circle"
              class="size-6 animate-spin text-muted"
            />
            <UIcon
              v-else
              :name="fileIcon(selectedFile)"
              class="size-12 text-muted"
            />
          </div>

          <UButton
            v-if="canUpdate && isTextEditable(selectedFile)"
            icon="i-lucide-pencil"
            :label="t('common.edit')"
            class="self-start"
            @click="openTextEditor(selectedFile)"
          />
          <UButton
            v-if="canUpdate && isImageFile(selectedFile)"
            icon="i-lucide-image"
            :label="t('common.edit')"
            class="self-start"
            @click="openImageEditor(selectedFile)"
          />

          <UButton
            icon="i-lucide-download"
            :label="t('common.download')"
            color="neutral"
            variant="outline"
            class="self-start"
            :loading="downloading"
            @click="downloadFile(selectedFile)"
          />

          <div
            v-if="canUpdate"
            class="flex flex-wrap gap-2"
          >
            <UPopover v-model:open="renameOpen">
              <UButton
                icon="i-lucide-text-cursor-input"
                :label="t('common.rename')"
                color="neutral"
                variant="outline"
              />
              <template #content>
                <form
                  class="flex w-72 flex-col gap-3 p-3"
                  @submit.prevent="renameFile"
                >
                  <UFormField
                    :label="t('common.name')"
                    :description="t('content.files.page.renameHelp')"
                  >
                    <UInput
                      v-model="renameDraft"
                      class="w-full"
                      autofocus
                    />
                  </UFormField>
                  <div class="flex justify-end gap-2">
                    <UButton
                      :label="t('common.cancel')"
                      color="neutral"
                      variant="ghost"
                      size="sm"
                      @click="renameOpen = false"
                    />
                    <UButton
                      type="submit"
                      :label="t('common.rename')"
                      size="sm"
                      :loading="renaming"
                      :disabled="!renameDraft.trim() || renameDraft.trim() === selectedFile.name"
                    />
                  </div>
                </form>
              </template>
            </UPopover>
            <UButton
              icon="i-lucide-folder-input"
              :label="t('content.files.page.moveToFolder')"
              color="neutral"
              variant="outline"
              @click="openMove([selectedFile])"
            />
          </div>

          <div class="space-y-2">
            <p class="text-xs font-medium uppercase text-muted">
              {{ t('common.details') }}
            </p>
            <dl class="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
              <dt class="text-muted">
                ID
              </dt>
              <dd class="truncate font-mono text-xs">
                {{ selectedFile.id }}
              </dd>
              <dt class="text-muted">
                {{ t('content.files.page.folder') }}
              </dt>
              <dd>{{ folderPath(selectedFile.folder) }}</dd>
              <dt class="text-muted">
                {{ t('common.name') }}
              </dt>
              <dd class="truncate">
                {{ selectedFile.name }}
              </dd>
              <dt class="text-muted">
                {{ t('content.files.page.extension') }}
              </dt>
              <dd class="uppercase">
                {{ selectedFile.extension }}
              </dd>
              <dt class="text-muted">
                {{ t('content.files.page.mimeType') }}
              </dt>
              <dd class="truncate font-mono text-xs">
                {{ selectedFile.mime_type }}
              </dd>
              <dt class="text-muted">
                {{ t('content.files.page.size') }}
              </dt>
              <dd>{{ formatBytes(selectedFile.size_bytes) }}</dd>
              <template v-if="selectedFile.width && selectedFile.height">
                <dt class="text-muted">
                  {{ t('content.files.page.dimensions') }}
                </dt>
                <dd>{{ selectedFile.width }} × {{ selectedFile.height }}px</dd>
              </template>
              <dt class="text-muted">
                {{ t('content.files.page.visibility') }}
              </dt>
              <dd>
                <button
                  type="button"
                  class="inline-flex"
                  @click="toggleVisibility(selectedFile)"
                >
                  <UBadge
                    :color="selectedFile.visibility === 'PUBLIC' ? 'success' : 'warning'"
                    variant="subtle"
                    size="sm"
                    class="cursor-pointer"
                  >
                    {{ selectedFile.visibility === 'PUBLIC' ? t('content.docs.endpoints.public') : t('content.files.page.private') }}
                  </UBadge>
                </button>
              </dd>
              <dt class="text-muted">
                {{ t('content.files.page.createdBy') }}
              </dt>
              <dd class="truncate">
                {{ userLabel(selectedFile.created_by) }}
              </dd>
              <dt class="text-muted">
                {{ t('content.files.page.modifiedBy') }}
              </dt>
              <dd class="truncate">
                {{ userLabel(selectedFile.updated_by) }}
              </dd>
              <dt class="text-muted">
                {{ t('content.files.page.created') }}
              </dt>
              <dd>{{ formatDate(selectedFile.created_at) }}</dd>
              <dt class="text-muted">
                {{ t('content.files.page.modified') }}
              </dt>
              <dd>{{ formatDate(selectedFile.updated_at) }}</dd>
            </dl>
          </div>

          <USeparator />

          <UFormField
            :label="t('common.description')"
            :description="t('content.files.page.descriptionHelp')"
          >
            <UTextarea
              v-model="editDescription"
              :rows="3"
              class="w-full"
            />
          </UFormField>

          <UFormField
            :label="t('content.files.page.tags')"
            :description="t('content.files.page.tagsHelp')"
          >
            <UInputTags
              v-model="editTags"
              class="w-full"
            />
          </UFormField>

          <USeparator />

          <div class="space-y-2">
            <p class="text-xs font-medium uppercase text-muted">
              {{ t('content.files.page.storage') }}
            </p>
            <dl class="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
              <!-- Provider/key never come out of the Data API (a protected
              column) - shown only where a response carries them. -->
              <template v-if="selectedFile.storage_key">
                <dt class="text-muted">
                  {{ t('content.files.page.provider') }}
                </dt>
                <dd>{{ selectedFile.storage_provider }}</dd>
                <dt class="text-muted">
                  {{ t('content.files.page.key') }}
                </dt>
                <dd class="truncate font-mono text-xs">
                  {{ selectedFile.storage_key }}
                </dd>
              </template>
              <dt class="text-muted">
                {{ t('content.files.page.checksum') }}
              </dt>
              <dd class="truncate font-mono text-xs">
                {{ selectedFile.checksum }}
              </dd>
            </dl>
          </div>

          <UButton
            v-if="canDelete"
            icon="i-lucide-trash-2"
            :label="t('common.deleteEllipsis')"
            color="error"
            variant="soft"
            class="self-start"
            @click="openDeleteFiles([selectedFile])"
          />
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            :label="t('common.close')"
            color="neutral"
            variant="ghost"
            :disabled="savingDetails"
            @click="selectedFile = null"
          />
          <UButton
            :label="t('common.save')"
            icon="i-lucide-save"
            :loading="savingDetails"
            @click="saveFileDetails"
          />
        </div>
      </template>
    </USlideover>

    <UModal
      v-model:open="isUploadOpen"
      :title="uploadFiles.length > 1 ? t('content.files.page.uploadN', { n: uploadFiles.length }) : t('content.files.page.uploadFile')"
      :ui="{ content: 'max-w-xl' }"
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <UFileUpload
            multiple
            :model-value="uploadFiles"
            :label="t('content.files.page.dropFiles')"
            :description="t('content.files.page.orBrowse')"
            class="min-h-48 w-full"
            @update:model-value="onUploadFilesSelected"
          />
        </div>
      </template>

      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="ghost"
            :disabled="uploading"
            @click="isUploadOpen = false"
          />
          <UButton
            :label="uploadFiles.length > 1 ? t('content.files.page.uploadN', { n: uploadFiles.length }) : t('common.upload')"
            icon="i-lucide-upload"
            :loading="uploading"
            :disabled="uploadFiles.length === 0"
            @click="uploadFilesToServer"
          />
        </div>
      </template>
    </UModal>

    <FilesTextEditorDrawer
      v-model:open="isEditorOpen"
      v-model="editorContent"
      :title="editorFile?.name ?? t('content.files.page.editFile')"
      :language="editorFile ? languageForFile(editorFile) : 'plaintext'"
      :loading="editorLoading"
      :saving="editorSaving"
      @save="saveTextEditor"
    />

    <FileEditDrawer
      v-model:open="isImageEditorOpen"
      :file="imageEditorFile"
      @replaced="onImageReplaced"
      @created="onImageSavedAs"
    />

    <!-- Bulk tags -->
    <UModal
      v-model:open="isBulkTagsOpen"
      :title="t('content.files.page.tags')"
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <p class="text-sm text-muted">
            <i18n-t
              keypath="content.files.page.bulkTagsApplies"
              scope="global"
            >
              <template #count>
                <span class="font-medium text-default">{{ selectedFiles.length }}</span>
              </template>
            </i18n-t>
          </p>
          <URadioGroup
            v-model="bulkTagsMode"
            :items="BULK_TAGS_MODE_OPTIONS"
          />
          <UFormField
            :label="t('content.files.page.tags')"
            :description="t('content.files.page.tagsEnter')"
          >
            <UInputTags
              v-model="bulkTagsDraft"
              class="w-full"
            />
          </UFormField>
          <div class="flex justify-end gap-2">
            <UButton
              :label="t('common.cancel')"
              color="neutral"
              variant="ghost"
              :disabled="bulkTagging"
              @click="isBulkTagsOpen = false"
            />
            <UButton
              :label="t('common.save')"
              :loading="bulkTagging"
              :disabled="bulkTagsDraft.length === 0"
              @click="saveBulkTags"
            />
          </div>
        </div>
      </template>
    </UModal>

    <!-- Move to folder: one file (the details sidebar) or the selection -->
    <UModal
      v-model:open="isMoveOpen"
      :title="moveTargets.length === 1 ? t('content.files.page.moveTitle') : t('content.files.page.moveN', { n: moveTargets.length })"
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <UFormField
            :label="t('content.files.page.folder')"
            :description="moveTargets.length === 1 ? t('content.files.page.moveWhereOne', { name: moveTargets[0]!.name }) : t('content.files.page.moveWhereMany')"
          >
            <USelectMenu
              v-model="moveFolder"
              :items="folderOptions"
              value-key="value"
              :aria-label="t('content.files.page.folder')"
              class="w-full"
            />
          </UFormField>
          <div class="flex justify-end gap-2">
            <UButton
              :label="t('common.cancel')"
              color="neutral"
              variant="ghost"
              :disabled="moving"
              @click="moveTargets = []"
            />
            <UButton
              :label="t('content.files.page.move')"
              :loading="moving"
              @click="confirmMove"
            />
          </div>
        </div>
      </template>
    </UModal>

    <UModal
      v-model:open="isDeleteOpen"
      :title="deleteTargets.length === 1 ? t('content.files.page.deleteOne') : t('content.files.page.deleteN', { n: deleteTargets.length })"
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <p class="text-sm text-muted">
            {{ t('content.files.page.deleteHelp') }}
          </p>
          <ul class="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-lg border border-default p-2">
            <li
              v-for="file in deleteTargets"
              :key="file.id"
              class="truncate text-sm"
            >
              {{ file.name }}
            </li>
          </ul>
          <div class="flex items-center justify-between gap-2 border-t border-default pt-4">
            <label class="flex cursor-pointer items-center gap-2">
              <UCheckbox v-model="deleteConfirmed" />
              <span class="text-sm">{{ t('common.confirm') }}</span>
            </label>
            <div class="flex gap-2">
              <UButton
                :label="t('common.cancel')"
                color="neutral"
                variant="ghost"
                :disabled="deletingFiles"
                @click="deleteTargets = []"
              />
              <UButton
                :label="t('common.delete')"
                color="error"
                :disabled="!deleteConfirmed"
                :loading="deletingFiles"
                @click="confirmDeleteFiles"
              />
            </div>
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
