<script setup lang="ts">
/**
 * An <img> whose src may be a deferred file reference (useFileObjectUrl's
 * deferredFileSrc): fetched only once the image is near the screen, so a
 * view of a hundred cards asks for the dozen on show, not all at once. Any
 * other src is shown as it is. Classes and alt go on the <img>.
 */
const props = defineProps<{ src: string }>()

const { resolveFileSrc } = useFileObjectUrl()

const root = useTemplateRef<HTMLImageElement>('root')
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

const resolved = computed(() => (seen.value ? resolveFileSrc(props.src) : undefined))
</script>

<template>
  <img
    ref="root"
    :src="resolved"
  >
</template>
