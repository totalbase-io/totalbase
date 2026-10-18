<script setup lang="ts">
// Wraps pdfme's Designer (vanilla JS, framework-agnostic - see pdfme.com
// docs) as a Vue component. Lazy-loaded via dynamic import from
// pages/templates/[id].vue so its canvas/pdf.js-heavy bundle only downloads when a
// PDF-kind template is actually opened, not on every admin page load.
//
// No v-model: pdfme's Designer has no lightweight "input" event suited to
// continuous two-way binding, and getTemplate() is cheap to call once -
// the parent calls it (via defineExpose) at save time instead. Page size
// (below) is the one exception - it has to act on the live designer
// instance via updateTemplate() the moment it changes, since it isn't
// something the designer's own canvas exposes a control for.
//
// On a phone or tablet (useCompactUi) it's pdfme's Viewer instead - the
// page as it will print, same theme, no palette, no field panels, nothing
// to drag: placing fields with a finger isn't practical, and the rest of
// the page (name, page size, Save) stays usable. Decided once, on mount.
//
// Emits `change` (no payload) on any user edit - pdfme's own
// onChangeTemplate, plus a page-size change here - so the parent can
// track unsaved changes without diffing the template itself; and `save`
// on pdfme's own Ctrl/Cmd+S shortcut, so it saves like the rest of the page.
const props = defineProps<{
  content: unknown
}>()
const emit = defineEmits<{ change: [], save: [] }>()
const { t, locale } = useI18n()

interface BasePdfSize {
  width: number
  height: number
  padding: [number, number, number, number]
}

const containerRef = ref<HTMLDivElement | null>(null)
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pdfme's own class, only typed inside its package
let designer: any = null
// False until the designer is built and the size refs are seeded from the
// loaded content - the size watchers below fire once for that seeding,
// which isn't a user edit and mustn't emit `change`.
let settled = false
// pdfme also fires onChangeTemplate on its own initial render (and on
// updateTemplate), not only on user edits - so a canvas change only
// counts once the user has actually pointed/typed inside the canvas.
let touched = false
function markTouched() {
  touched = true
}
const loading = ref(true)
const loadError = ref<string | null>(null)
const previewOnly = useCompactUi().value

// pdfme's own UI is Ant Design - themed here to match the admin (primary,
// Inter, radii) and to follow light/dark with antd's own dark algorithm
// (colors alone left its form labels dark on dark and its inputs white) -
// run here, through getDesignToken, since pdfme structuredClone()s its
// options and a function (the algorithm itself) can't be cloned: it gets
// the resulting flat token set instead.
// antd is pdfme's dependency, declared by the admin at the same version so
// its theme module (`antd/es/theme`, loaded with pdfme below) is the same
// instance pdfme renders with. Hex, not the admin's CSS variables: antd
// computes its derived shades in JS and can't read oklch(). Slate/blue -
// app.config.ts' neutral/primary - as Nuxt UI resolves them (primary 500
// light, 400 dark; bg white / 900).
// What pdfme paints with inline styles instead (the canvas, the sidebars,
// the margin bands, the zoom bar) is the <style> block at the bottom.
const colorMode = useColorMode()
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- antd's theme module, loaded lazily with pdfme
let antdTheme: any = null
function pdfmeTheme(dark: boolean) {
  const seed = {
    colorPrimary: dark ? '#60a5fa' : '#3b82f6',
    colorBgBase: dark ? '#0f172a' : '#ffffff',
    colorTextBase: dark ? '#f8fafc' : '#0f172a',
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, sans-serif',
    borderRadius: 6
  }
  if (!antdTheme) return { token: seed }
  return { token: antdTheme.getDesignToken({ algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm, token: seed }) }
}
watch(() => colorMode.value, (mode) => {
  designer?.updateOptions({ theme: pdfmeTheme(mode === 'dark') })
})
// pdfme's own texts (its panels, dialogs) in the UI's language - it ships both English and Spanish.
const pdfmeLang = (): 'es' | 'en' => (locale.value === 'es' ? 'es' : 'en')
watch(locale, () => {
  designer?.updateOptions({ lang: pdfmeLang() })
})
// pdfme's signature plugin ships no icon - its palette button showed a
// clipped "Signa" label. Lucide's `signature`, as the other entries' look.
const SIGNATURE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21 17-2.156-1.868A.5.5 0 0 0 18 15.5v.5a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1c0-2.545-3.991-3.97-8.5-4a1 1 0 0 0 0 5c4.153 0 4.745-11.295 5.708-13.5a2.5 2.5 0 1 1 3.31 3.284"/><path d="M3 21h18"/></svg>'

const BLANK_BASE_PDF: BasePdfSize = { width: 210, height: 297, padding: [10, 10, 10, 10] }
const BLANK_TEMPLATE = { basePdf: BLANK_BASE_PDF, schemas: [[]] }

// pdfme's own basePdf can alternatively be a real PDF file (string/binary)
// used as a background - never how templates.vue creates one (it always
// starts from BLANK_TEMPLATE's plain {width,height,padding} object), but
// a template edited outside the admin could set one. The size controls
// below only make sense for the object form, so they're hidden rather
// than shown against a value they can't actually represent.
const sizeEditable = ref(true)
const PRESETS: Array<{ label: string, width: number, height: number, margin: number }> = [
  { label: 'A3', width: 297, height: 420, margin: 10 },
  { label: 'A4', width: 210, height: 297, margin: 10 },
  { label: 'A5', width: 148, height: 210, margin: 8 },
  { label: 'A6', width: 105, height: 148, margin: 5 },
  { label: 'Letter', width: 215.9, height: 279.4, margin: 10 },
  { label: 'Legal', width: 215.9, height: 355.6, margin: 10 },
  { label: 'Tabloid', width: 279.4, height: 431.8, margin: 10 },
  { label: 'Receipt (58mm)', width: 58, height: 297, margin: 3 },
  { label: 'Receipt (80mm)', width: 80, height: 297, margin: 3 },
  { label: 'Receipt (112mm)', width: 112, height: 297, margin: 3 },
  { label: 'Custom', width: 0, height: 0, margin: 0 }
]
// `label` is the preset's identity (and its name where it's a paper size);
// the ones that are words are shown translated.
const PRESET_KEYS: Record<string, string> = {
  'Letter': 'letter',
  'Legal': 'legal',
  'Tabloid': 'tabloid',
  'Receipt (58mm)': 'receipt58',
  'Receipt (80mm)': 'receipt80',
  'Receipt (112mm)': 'receipt112',
  'Custom': 'custom'
}
const presetItems = computed(() => PRESETS.map(p => ({
  label: PRESET_KEYS[p.label] ? t(`content.templates.pdfDesigner.presets.${PRESET_KEYS[p.label]}`) : p.label,
  value: p.label
})))
const preset = ref<string>('Custom')
const width = ref(BLANK_BASE_PDF.width)
const height = ref(BLANK_BASE_PDF.height)
const margin = ref(BLANK_BASE_PDF.padding[0])

function matchPreset(size: BasePdfSize): string {
  const found = PRESETS.find(p =>
    p.label !== 'Custom' && p.width === size.width && p.height === size.height && p.margin === size.padding[0]
  )
  return found?.label ?? 'Custom'
}

function applyPreset(label: string) {
  const found = PRESETS.find(p => p.label === label)
  if (!found || found.label === 'Custom') return
  width.value = found.width
  height.value = found.height
  margin.value = found.margin
}

// Pushed to the live designer on any change - getTemplate() carries the
// schemas the user has already placed, so only basePdf is replaced, not
// the whole document.
function applySize() {
  if (!designer || !sizeEditable.value) return
  const current = designer.getTemplate()
  designer.updateTemplate({
    ...current,
    basePdf: { width: width.value, height: height.value, padding: [margin.value, margin.value, margin.value, margin.value] }
  })
  if (settled) emit('change')
}

watch(preset, (label) => {
  applyPreset(label)
  applySize()
})
watch([width, height, margin], () => {
  preset.value = matchPreset({ width: width.value, height: height.value, padding: [margin.value, margin.value, margin.value, margin.value] })
  applySize()
})

onMounted(async () => {
  try {
    const [{ Designer, Viewer }, schemas, themeModule, { getInputFromTemplate }] = await Promise.all([
      import('@pdfme/ui'),
      import('@pdfme/schemas'),
      import('antd/es/theme'),
      import('@pdfme/common')
    ])
    antdTheme = themeModule.default
    if (!containerRef.value) return
    // pdfme's Designer is React-based internally and structuredClone()s the
    // template it's given - a Vue reactive Proxy (props.content flows from a
    // useAsyncData()-fetched ref) isn't structured-cloneable and throws. The
    // JSON round-trip strips reactivity; content is always JSON anyway (a
    // jsonb column), so nothing is lost.
    const raw = props.content && typeof props.content === 'object' ? JSON.parse(JSON.stringify(props.content)) : BLANK_TEMPLATE
    const template = raw as ConstructorParameters<typeof Designer>[0]['template']

    const basePdf = template.basePdf
    if (basePdf && typeof basePdf === 'object' && 'width' in basePdf && 'height' in basePdf) {
      sizeEditable.value = true
      width.value = basePdf.width
      height.value = basePdf.height
      margin.value = Array.isArray(basePdf.padding) ? basePdf.padding[0] : BLANK_BASE_PDF.padding[0]
      preset.value = matchPreset({ width: width.value, height: height.value, padding: [margin.value, margin.value, margin.value, margin.value] })
    } else {
      sizeEditable.value = false
    }

    // The full field palette @pdfme/schemas ships (same set pdfme's own
    // playground exposes), not just Text - a single line item was all
    // this had before, which left every other field type (tables,
    // images, checkboxes, barcodes, ...) unreachable from this designer
    // even though the rendering/PDF-generation side already supports
    // them.
    const plugins = {
      'Text': schemas.text,
      'Multi-Variable Text': schemas.multiVariableText,
      'Table': schemas.table,
      'List': schemas.list,
      'Line': schemas.line,
      'Rectangle': schemas.rectangle,
      'Ellipse': schemas.ellipse,
      'Image': schemas.image,
      'SVG': schemas.svg,
      'Signature': { ...schemas.signature, icon: SIGNATURE_ICON },
      'Select': schemas.select,
      'Checkbox': schemas.checkbox,
      'Radio Group': schemas.radioGroup,
      'Circle Mark': schemas.circleMark,
      'Date': schemas.date,
      'Time': schemas.time,
      'Date & Time': schemas.dateTime,
      'QR Code': schemas.barcodes.qrcode,
      'Barcode (Code128)': schemas.barcodes.code128,
      'Barcode (EAN-13)': schemas.barcodes.ean13,
      'Barcode (UPC-A)': schemas.barcodes.upca
    }
    const options = { theme: pdfmeTheme(colorMode.value === 'dark'), lang: pdfmeLang() }
    designer = previewOnly
      ? new Viewer({ domContainer: containerRef.value, template, inputs: getInputFromTemplate(template), options, plugins })
      : new Designer({ domContainer: containerRef.value, template, options, plugins })
    if (!previewOnly) {
      designer.onChangeTemplate(() => {
        if (touched) emit('change')
      })
      designer.onSaveTemplate(() => emit('save'))
    }
    await nextTick()
    settled = true
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : t('content.templates.pdfDesigner.loadError')
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  designer?.destroy()
  designer = null
})

defineExpose({
  getTemplate: () => designer?.getTemplate()
})
</script>

<template>
  <!-- Fills its parent's height (the editor page gives it the rest of the
  viewport below the header) instead of a fixed 70vh - min-h keeps the
  canvas usable on a short window. -->
  <div class="flex h-full min-h-0 flex-col gap-2">
    <UAlert
      v-if="loadError"
      color="error"
      variant="subtle"
      :title="loadError"
    />

    <!-- Page size - pdfme's own canvas has no control for this (it only
        edits field placement), so it lives here instead. A preset fills
        width/height/margin in one click; typing any of the three drops
        the preset to "Custom" and pushes the change straight to the live
        canvas via designer.updateTemplate(). -->
    <div
      v-if="!loading && sizeEditable"
      class="flex flex-wrap items-center gap-2 shrink-0"
    >
      <USelect
        v-model="preset"
        :aria-label="t('content.templates.pdfDesigner.pageSize')"
        :items="presetItems"
        value-key="value"
        size="sm"
        class="w-40"
      />
      <div class="w-px h-5 bg-border mx-1" />
      <span class="text-sm text-muted">{{ t('content.templates.pdfDesigner.width') }}</span>
      <UInputNumber
        v-model="width"
        :aria-label="t('content.templates.pdfDesigner.width')"
        :min="10"
        :max="2000"
        size="sm"
        class="w-28"
      />
      <span class="text-sm text-muted">{{ t('content.templates.pdfDesigner.height') }}</span>
      <UInputNumber
        v-model="height"
        :aria-label="t('content.templates.pdfDesigner.height')"
        :min="10"
        :max="2000"
        size="sm"
        class="w-28"
      />
      <span class="text-sm text-muted">{{ t('content.templates.pdfDesigner.margin') }}</span>
      <UInputNumber
        v-model="margin"
        :aria-label="t('content.templates.pdfDesigner.margin')"
        :min="0"
        :max="100"
        size="sm"
        class="w-24"
      />
      <span class="text-xs text-muted">mm</span>
    </div>
    <UAlert
      v-else-if="!loading"
      color="neutral"
      variant="subtle"
      :title="t('content.templates.pdfDesigner.fixedPdf')"
    />

    <p
      v-if="previewOnly && !loading"
      class="flex shrink-0 items-center gap-1.5 text-xs text-muted"
    >
      <UIcon
        name="i-lucide-monitor"
        class="size-3.5 shrink-0"
      />
      {{ t('content.templates.pdfDesigner.largerScreen') }}
    </p>
    <div
      v-if="loading"
      class="flex items-center justify-center h-24 text-muted text-sm"
    >
      {{ t('content.templates.pdfDesigner.loading') }}
    </div>
    <div
      ref="containerRef"
      class="pdf-designer w-full min-h-[480px] flex-1 border border-default rounded-lg overflow-hidden"
      :class="loading ? 'hidden' : ''"
      @pointerdown.capture="markTouched"
      @keydown.capture="markTouched"
    />
  </div>
</template>

<!--
  What pdfme paints with inline styles (so its Ant Design theme above can't
  reach it) - overridden here under `.pdf-designer` (this component's own
  container, so nothing outside it). Not `scoped`: the dark rules key off
  the app's own `.dark` class on <html>. These selectors follow pdfme's
  DOM (@pdfme/ui 6.x): recheck them on a pdfme upgrade.
-->
<style>
/* The canvas around the page - the admin's accented background, not a fixed #4a4a4a. */
.pdf-designer .pdfme-designer-root {
  background: var(--ui-bg-accented) !important;
}

/* Field palette (left) and Field List / Edit Field (right): the admin's
   background, border and font instead of a fixed light gray. */
.pdf-designer .pdfme-designer-left-sidebar {
  background: var(--ui-bg) !important;
  border-right: 1px solid var(--ui-border);
  overflow-x: hidden !important;
}
.pdf-designer .pdfme-designer-right-sidebar > div {
  background: var(--ui-bg) !important;
  border-left: 1px solid var(--ui-border);
  font-family: var(--font-sans) !important;
}

/* The page's margin bands (antd's error color at 25%, whatever shade the
   theme resolves it to): a faint primary tint instead. */
.pdf-designer .pdfme-designer-root div[style*="pointer-events: none"][style*="opacity: 0.25"] {
  background: var(--ui-primary) !important;
  opacity: 0.08 !important;
}

/* Zoom / page bar floating over the page: slate, as the admin's neutrals. */
.pdf-designer .pdfme-ui-control-bar {
  background: rgb(15 23 42 / 0.8) !important;
  border-radius: 0.5rem;
}

/* Edit Field's form is rendered by form-render (`fr-form`) inside its own
   Ant Design context, which never receives pdfme's theme - in dark mode
   its labels stayed near-black and its inputs white. The admin's own
   dark colors instead. (Light mode already matches.) */
.dark .pdf-designer .fr-form,
.dark .pdf-designer .fr-form .ant-form-item,
.dark .pdf-designer .fr-form label,
.dark .pdf-designer .fr-form .ant-form-item-label > label,
.dark .pdf-designer .fr-form .ant-checkbox-wrapper,
.dark .pdf-designer .fr-form .ant-checkbox-wrapper span,
.dark .pdf-designer .fr-form .ant-radio-wrapper,
.dark .pdf-designer .fr-form .ant-radio-wrapper span {
  color: var(--ui-text) !important;
}
.dark .pdf-designer .fr-form .ant-input,
.dark .pdf-designer .fr-form .ant-input-affix-wrapper,
.dark .pdf-designer .fr-form .ant-input-number,
.dark .pdf-designer .fr-form .ant-input-number-input,
.dark .pdf-designer .fr-form .ant-select-selector,
.dark .pdf-designer .fr-form .ant-select-selection-item,
.dark .pdf-designer .fr-form .ant-btn {
  background: var(--ui-bg) !important;
  color: var(--ui-text) !important;
  border-color: var(--ui-border-accented) !important;
}
/* Unchecked only - a checked box keeps antd's primary fill. */
.dark .pdf-designer .fr-form .ant-checkbox:not(.ant-checkbox-checked) .ant-checkbox-inner,
.dark .pdf-designer .fr-form .ant-radio:not(.ant-radio-checked) .ant-radio-inner {
  background: var(--ui-bg);
  border-color: var(--ui-border-accented);
}
.dark .pdf-designer .fr-form .ant-divider {
  border-color: var(--ui-border) !important;
}
</style>
