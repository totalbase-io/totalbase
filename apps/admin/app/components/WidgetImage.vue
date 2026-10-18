<script setup lang="ts">
/**
 * The Image widget (TImage, Specification_DataViews.md §9.10): an image on a page - uploaded in the designer (a
 * PUBLIC file: anyone who opens the page sees it, no grant on files), a file of the record
 * (`{{vars.record.data.foto}}`, read with the viewer's own token and grant) or an https URL. Always an `<img>`,
 * an SVG included - an image never runs a script. Framed by its shape (`aspect`), `fit`, `height`, `maxWidth`
 * and `corners`; a caption under it; an icon and a line when there's none. With Clicked wired it reads as a
 * button (a scanner's trigger, say).
 */
const props = withDefaults(defineProps<{
  /** A file's id, or a URL. */
  src?: string | null
  alt?: string
  caption?: string
  aspect?: 'original' | '1:1' | '3:4' | '4:3' | '16:9'
  fit?: 'cover' | 'contain'
  height?: number
  maxWidth?: number
  corners?: 'none' | 'sm' | 'md' | 'lg' | 'xl' | 'full'
  emptyIcon?: string
  emptyText?: string
}>(), {
  src: undefined,
  alt: undefined,
  caption: undefined,
  aspect: 'original',
  fit: 'contain',
  height: undefined,
  maxWidth: undefined,
  corners: 'md',
  emptyIcon: undefined,
  emptyText: undefined
})
const emit = defineEmits<{ click: [event: MouseEvent | KeyboardEvent] }>()

const session = useSession()
/** Clicked is wired: a button, reachable from the keyboard. */
const clickable = !!getCurrentInstance()?.vnode.props?.onClick

const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** What the `<img>` shows: a URL as it is; a file read with the viewer's token (a PUBLIC one needs none) into a blob. */
const url = ref<string | null>(null)
const failed = ref(false)
let objectUrl: string | null = null
function release() {
  if (objectUrl) URL.revokeObjectURL(objectUrl)
  objectUrl = null
}
watch(() => props.src, async (src) => {
  release()
  failed.value = false
  url.value = null
  const value = typeof src === 'string' ? src.trim() : ''
  if (!value) return
  const path = FILE_ID.test(value) ? `/api/totalbase/table/files/${value}` : value.startsWith('/') ? value : null
  if (!path) {
    url.value = /^https?:\/\//i.test(value) ? value : null
    return
  }
  try {
    const response = await $fetch.raw(path, {
      baseURL: '',
      responseType: 'blob',
      headers: session.token.value ? { Authorization: `Bearer ${session.token.value}` } : undefined
    })
    objectUrl = URL.createObjectURL(response._data as Blob)
    url.value = objectUrl
  } catch {
    failed.value = true
  }
}, { immediate: true })
onBeforeUnmount(release)

const RATIOS: Record<string, string | undefined> = { 'original': undefined, '1:1': '1 / 1', '3:4': '3 / 4', '4:3': '4 / 3', '16:9': '16 / 9' }
const RADIUS: Record<string, string> = { none: 'rounded-none', sm: 'rounded-sm', md: 'rounded-md', lg: 'rounded-lg', xl: 'rounded-xl', full: 'rounded-full' }
/** The frame: its shape and height, its largest width; the image fills it by `fit`. */
const frameStyle = computed(() => ({
  aspectRatio: RATIOS[props.aspect],
  height: props.height ? `${props.height}px` : undefined,
  maxWidth: props.maxWidth ? `${props.maxWidth}px` : undefined
}))
const framed = computed(() => !!RATIOS[props.aspect] || !!props.height)

function onClick(event: MouseEvent | KeyboardEvent) {
  if (clickable) emit('click', event)
}
</script>

<template>
  <figure class="flex w-full flex-col items-center gap-1.5">
    <component
      :is="clickable ? 'button' : 'div'"
      :type="clickable ? 'button' : undefined"
      class="relative w-full overflow-hidden"
      :class="[RADIUS[corners], clickable ? 'cursor-pointer focus-visible:outline-2 focus-visible:outline-primary' : undefined]"
      :style="frameStyle"
      :aria-label="clickable ? (alt || caption || undefined) : undefined"
      @click="onClick"
    >
      <img
        v-if="url"
        :src="url"
        :alt="alt ?? ''"
        class="block w-full"
        :class="[framed ? 'h-full' : 'h-auto', fit === 'cover' ? 'object-cover' : 'object-contain']"
        @error="failed = true; url = null"
      >
      <div
        v-else
        class="flex size-full min-h-24 flex-col items-center justify-center gap-1 border border-dashed border-default p-3 text-center text-muted"
        :class="RADIUS[corners]"
      >
        <UIcon
          :name="failed ? 'i-lucide-image-off' : (emptyIcon || 'i-lucide-image')"
          class="size-6"
        />
        <span
          v-if="emptyText"
          class="text-sm"
        >{{ emptyText }}</span>
      </div>
    </component>
    <figcaption
      v-if="caption"
      class="text-center text-sm text-muted"
    >
      {{ caption }}
    </figcaption>
  </figure>
</template>
