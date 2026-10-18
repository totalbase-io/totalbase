<script setup lang="ts">
/**
 * The device camera's live picture - shared by the Scanner (TScanner) and
 * Camera (TCamera) widgets (Specification_DataViews.md §9.9). Opens the
 * stream when mounted, stops every track when unmounted or when the facing
 * changes, and says why there is none (no HTTPS, permission denied, no
 * camera) instead of a black box.
 */
import { openCamera, type CameraProblem } from '~/utils/code-scanner'

const props = withDefaults(defineProps<{
  facing?: 'environment' | 'user'
  /** The resolution asked for - a scan reads better at full HD, a photo too. */
  ideal?: { width: number, height: number }
}>(), {
  facing: 'environment',
  ideal: () => ({ width: 1920, height: 1080 })
})
const emit = defineEmits<{
  ready: [video: HTMLVideoElement]
  problem: [problem: CameraProblem, message: string]
}>()

const { t } = useI18n()
const video = ref<HTMLVideoElement | null>(null)
const problem = ref<CameraProblem | null>(null)
const starting = ref(true)
let stream: MediaStream | null = null

function stop() {
  stream?.getTracks().forEach(track => track.stop())
  stream = null
}

async function start() {
  stop()
  starting.value = true
  problem.value = null
  const opened = await openCamera(props.facing, props.ideal)
  starting.value = false
  if ('problem' in opened) {
    problem.value = opened.problem
    emit('problem', opened.problem, opened.message)
    return
  }
  stream = opened.stream
  if (!video.value) return stop()
  video.value.srcObject = stream
  await video.value.play().catch(() => {})
  emit('ready', video.value)
}

onMounted(start)
watch(() => props.facing, start)
onBeforeUnmount(stop)

defineExpose({ video, stop })

const problemText = computed(() => problem.value ? t(`designer.cameraFeed.problems.${problem.value}`) : '')
</script>

<template>
  <div class="relative size-full overflow-hidden bg-black">
    <video
      ref="video"
      class="size-full object-cover"
      :class="facing === 'user' && '-scale-x-100'"
      autoplay
      muted
      playsinline
    />
    <slot v-if="!problem && !starting" />
    <UEmpty
      v-if="starting"
      loading
      variant="naked"
      size="sm"
      class="absolute inset-0 text-inverted"
    />
    <UEmpty
      v-else-if="problem"
      icon="i-lucide-camera-off"
      :title="t('designer.cameraFeed.unavailable')"
      :description="problemText"
      class="absolute inset-0 m-4 bg-default"
    />
  </div>
</template>
