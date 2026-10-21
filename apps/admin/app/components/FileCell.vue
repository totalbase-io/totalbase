<script setup lang="ts">
/**
 * A file column's cell in a list (a foreign key to files - DataViews.md §4): an image as a
 * fixed 40 px thumbnail (scaled down by the server), opening large in a viewer; another file as its type's icon and
 * name, downloading it. Both read with the viewer's token - a PRIVATE file answers nothing else - and only once
 * the cell is on screen. Clicks stay in the cell: the row's own click (open the record) never fires.
 */
const props = defineProps<{ fileId: string }>()

const { t } = useI18n()
const isCompact = useCompactUi()
const session = useSession()
const toast = useToast()
const { fileInfo } = useFileInfo()
const { fileObjectUrl } = useFileObjectUrl()

const root = useTemplateRef<HTMLElement>('root')
const seen = ref(false)
let observer: IntersectionObserver | null = null
onMounted(() => {
  if (!root.value || typeof IntersectionObserver === 'undefined') {
    seen.value = true
    return
  }
  observer = new IntersectionObserver((entries) => {
    if (entries.some(e => e.isIntersecting)) {
      seen.value = true
      observer?.disconnect()
    }
  }, { rootMargin: '200px' })
  observer.observe(root.value)
})
onBeforeUnmount(() => observer?.disconnect())

const info = computed(() => (seen.value ? fileInfo(props.fileId) : undefined))
const isImage = computed(() => info.value?.mime_type?.startsWith('image/') === true)
const thumb = computed(() => (isImage.value ? fileObjectUrl(props.fileId, 80) : undefined))

const viewerOpen = ref(false)
const large = computed(() => (viewerOpen.value ? fileObjectUrl(props.fileId, 1600) : undefined))

function fileIcon(mime: string | undefined): string {
  if (!mime) return 'i-lucide-file'
  if (mime === 'application/pdf') return 'i-lucide-file-text'
  if (mime.startsWith('video/')) return 'i-lucide-file-video'
  if (mime.startsWith('audio/')) return 'i-lucide-file-audio'
  if (mime.includes('spreadsheet') || mime.includes('excel') || mime === 'text/csv') return 'i-lucide-file-spreadsheet'
  if (mime.startsWith('text/') || mime.includes('word') || mime.includes('document')) return 'i-lucide-file-text'
  if (mime.includes('zip') || mime.includes('compressed')) return 'i-lucide-file-archive'
  return 'i-lucide-file'
}

async function download() {
  try {
    const response = await $fetch.raw(`/api/totalbase/table/files/${props.fileId}`, {
      baseURL: '',
      responseType: 'blob',
      headers: session.token.value ? { Authorization: `Bearer ${session.token.value}` } : undefined
    })
    const url = URL.createObjectURL(response._data as Blob)
    const a = document.createElement('a')
    a.href = url
    a.download = info.value?.name ?? 'file'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch {
    toast.add({ title: t('dataviews.grid.fileDownloadError'), color: 'error' })
  }
}
</script>

<template>
  <span
    ref="root"
    class="inline-flex max-w-full min-w-0 items-center"
    @click.stop
  >
    <!-- An image: a fixed thumbnail - the row keeps its height. -->
    <button
      v-if="isImage"
      type="button"
      class="block size-10 shrink-0 cursor-zoom-in overflow-hidden rounded-md border border-default bg-elevated"
      :aria-label="t('dataviews.grid.fileView', { name: info?.name ?? '' })"
      @click="viewerOpen = true"
    >
      <img
        v-if="thumb"
        :src="thumb"
        :alt="info?.name ?? ''"
        class="size-full object-cover"
      >
    </button>
    <!-- Another file: its type and name, to download. -->
    <UButton
      v-else-if="info"
      :icon="fileIcon(info.mime_type)"
      :label="info.name"
      color="neutral"
      variant="link"
      size="xs"
      class="min-w-0 max-w-full truncate px-0"
      @click="download"
    />
    <!-- Loading, or not readable by this viewer: a placeholder of the thumbnail's size. -->
    <span
      v-else
      class="flex size-10 items-center justify-center rounded-md border border-dashed border-default text-dimmed"
    >
      <UIcon
        :name="info === null ? 'i-lucide-file-x' : 'i-lucide-file'"
        class="size-4"
      />
    </span>

    <!-- A wide viewer: fullscreen on a phone or a tablet (AGENTS.md §25). -->
    <UModal
      v-model:open="viewerOpen"
      :title="info?.name"
      :fullscreen="isCompact"
      :ui="{ content: isCompact ? undefined : 'sm:max-w-4xl' }"
    >
      <template #body>
        <div class="flex min-h-48 items-center justify-center">
          <img
            v-if="large"
            :src="large"
            :alt="info?.name ?? ''"
            class="max-h-[75vh] max-w-full rounded-md object-contain"
          >
          <UEmpty
            v-else
            loading
            variant="naked"
            size="sm"
          />
        </div>
      </template>
    </UModal>
  </span>
</template>
