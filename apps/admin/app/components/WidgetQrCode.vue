<script setup lang="ts">
/**
 * TQrCode (WIDGET_CATALOG) - a QR code of a value, drawn in the browser by zxing-wasm's writer (the same
 * library the Scanner reads with, its .wasm served by the admin itself): the value - a device's one-time
 * pairing code - never leaves the page. Empty, a placeholder instead of an unreadable code.
 */
const props = withDefaults(defineProps<{
  value?: string | number | null
  size?: number
  errorCorrection?: 'L' | 'M' | 'Q' | 'H'
  caption?: string
  download?: boolean
}>(), { value: null, size: 200, errorCorrection: 'M', caption: undefined, download: false })

const { t } = useI18n()
const svg = ref<string | null>(null)
const failed = ref(false)
const text = computed(() => (props.value === null || props.value === undefined ? '' : String(props.value)))

let writer: Promise<typeof import('zxing-wasm/writer')> | null = null
/** zxing-wasm's writer, its .wasm from the admin's own assets - loaded once, on the first code drawn. */
function loadWriter() {
  writer ??= Promise.all([import('zxing-wasm/writer'), import('zxing-wasm/writer/zxing_writer.wasm?url')]).then(([module, wasm]) => {
    module.prepareZXingModule({ overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasm.default : prefix + path) }, fireImmediately: false })
    return module
  })
  return writer
}

watch([text, () => props.errorCorrection], async ([value, ec]) => {
  failed.value = false
  if (!value) {
    svg.value = null
    return
  }
  try {
    const { writeBarcode } = await loadWriter()
    const result = await writeBarcode(value, { format: 'QRCode', options: `ecLevel=${ec}` })
    if (result.error) throw new Error(result.error)
    svg.value = scalable(result.svg)
  } catch {
    svg.value = null
    failed.value = true
  }
}, { immediate: true })

/**
 * The writer's SVG as a scalable element: no XML prolog or DOCTYPE inside the page, a viewBox from its own
 * size so it fills the box it's given, square modules kept crisp.
 */
function scalable(raw: string): string {
  const svgOnly = raw.slice(raw.indexOf('<svg'))
  const size = /<svg[^>]*\swidth="(\d+)"[^>]*\sheight="(\d+)"/.exec(svgOnly)
  if (!size) return svgOnly
  return svgOnly.replace('<svg', `<svg viewBox="0 0 ${size[1]} ${size[2]}" preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges"`)
}

const side = computed(() => `${Math.max(48, Number(props.size) || 200)}px`)

function save() {
  if (!svg.value) return
  const url = URL.createObjectURL(new Blob([svg.value], { type: 'image/svg+xml' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'qr.svg'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function print() {
  if (!svg.value) return
  const frame = document.createElement('iframe')
  frame.style.position = 'fixed'
  frame.style.width = '0'
  frame.style.height = '0'
  frame.style.border = '0'
  document.body.appendChild(frame)
  const doc = frame.contentDocument
  if (!doc) return
  doc.open()
  doc.write(`<!doctype html><title>QR</title><body style="display:flex;flex-direction:column;align-items:center;gap:12px;font-family:sans-serif;padding:24px"><div style="width:${side.value};height:${side.value}">${svg.value}</div>${props.caption ? `<p style="font-size:18px;letter-spacing:.1em"></p>` : ''}</body>`)
  doc.close()
  const p = doc.querySelector('p')
  if (p && props.caption) p.textContent = props.caption
  const sized = doc.querySelector('svg')
  if (sized) {
    sized.setAttribute('width', '100%')
    sized.setAttribute('height', '100%')
  }
  frame.contentWindow?.print()
  setTimeout(() => frame.remove(), 1000)
}
</script>

<template>
  <div class="flex flex-col items-center gap-2">
    <!-- zxing-wasm's own SVG of the value: shapes only, no script and no text taken from the value. -->
    <!-- eslint-disable vue/no-v-html -->
    <div
      v-if="svg"
      class="qr-code rounded-md bg-white p-2"
      :style="{ width: side, height: side }"
      role="img"
      :aria-label="t('dataviews.widgetQrCode.label')"
      v-html="svg"
    />
    <!-- eslint-enable vue/no-v-html -->
    <div
      v-else
      class="flex flex-col items-center justify-center gap-1 rounded-md border border-dashed border-default text-sm text-muted"
      :style="{ width: side, height: side }"
    >
      <UIcon
        :name="failed ? 'i-lucide-triangle-alert' : 'i-lucide-qr-code'"
        class="size-6"
      />
      {{ failed ? t('dataviews.widgetQrCode.failed') : t('dataviews.widgetQrCode.empty') }}
    </div>
    <p
      v-if="caption"
      class="font-mono text-sm tracking-wider text-highlighted"
    >
      {{ caption }}
    </p>
    <div
      v-if="download && svg"
      class="flex gap-2"
    >
      <UButton
        icon="i-lucide-download"
        :label="t('dataviews.widgetQrCode.download')"
        color="neutral"
        variant="outline"
        size="xs"
        @click="save"
      />
      <UButton
        icon="i-lucide-printer"
        :label="t('dataviews.widgetQrCode.print')"
        color="neutral"
        variant="outline"
        size="xs"
        @click="print"
      />
    </div>
  </div>
</template>

<style scoped>
.qr-code :deep(svg) {
  width: 100%;
  height: 100%;
}
</style>
