<script setup lang="ts">
/**
 * A file a dashboard widget's query returned (Dashboards.md §5.16, D14), by the link the run signed
 * for it (`result.files[id]` - an `<img>` sends no header, the signature is the access): an image as a thumbnail
 * that opens large on a tap (`thumb`), filling its box (`fill`), anything else - or `link` - a link to it. An embed's
 * PRIVATE file without allowFiles (`blocked`) says it isn't available there.
 */
import type { DashboardFileLink } from '~/types/dashboard'

const props = withDefaults(defineProps<{
  file?: DashboardFileLink | null
  variant?: 'thumb' | 'fill' | 'link'
  alt?: string
}>(), {
  file: null,
  variant: 'thumb',
  alt: ''
})

const { t } = useI18n()
const open = ref(false)
const isImage = computed(() => Boolean(props.file?.image && props.file.url) && props.variant !== 'link')
</script>

<template>
  <span
    v-if="file?.blocked"
    class="inline-flex min-w-0 items-center gap-1 text-xs text-muted"
    :class="{ 'h-full w-full justify-center': variant === 'fill' }"
    :title="t('dashboards.widgetView.fileBlocked')"
  >
    <UIcon
      name="i-lucide-image-off"
      class="size-4 shrink-0"
    />
    <span :class="variant === 'thumb' ? 'sr-only' : 'truncate'">{{ t('dashboards.widgetView.fileBlocked') }}</span>
  </span>

  <template v-else-if="file && isImage">
    <button
      type="button"
      class="shrink-0 overflow-hidden rounded focus-visible:outline-2 focus-visible:outline-primary"
      :class="variant === 'fill' ? 'flex h-full w-full items-center justify-center' : 'inline-flex size-8 align-middle'"
      :aria-label="t('dashboards.widgetView.openImage', { name: file.name })"
      @click.stop="open = true"
      @keydown.enter.stop
    >
      <img
        :src="file.url!"
        :alt="alt || file.name"
        loading="lazy"
        :class="variant === 'fill' ? 'max-h-full max-w-full object-contain' : 'size-8 object-cover'"
      >
    </button>
    <UModal
      v-model:open="open"
      :title="file.name"
    >
      <template #body>
        <img
          :src="file.url!"
          :alt="alt || file.name"
          class="mx-auto max-h-[75vh] w-auto object-contain"
        >
      </template>
    </UModal>
  </template>

  <a
    v-else-if="file?.url"
    :href="file.url"
    target="_blank"
    rel="noopener noreferrer"
    class="inline-flex min-w-0 items-center gap-1 text-primary hover:underline"
    @click.stop
  >
    <UIcon
      name="i-lucide-paperclip"
      class="size-3.5 shrink-0"
    />
    <span class="truncate">{{ file.name }}</span>
  </a>

  <span
    v-else-if="file"
    class="truncate text-muted"
  >{{ file.name }}</span>
</template>
