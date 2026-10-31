<script setup lang="ts">
/**
 * A CUSTOM DataView, live (DataViews.md §13.1) -
 * the App page and the Design form's Preview both mount it. Its variables
 * load, its widgets draw bound to them, its Code runs on their events;
 * every read and write is the viewer's, through the Data API.
 *
 * Config arrives as props, never from the route (AGENTS.md section 21A):
 * the host passes the DataView (draft or published) and its widgets. Keyed
 * by the host on the version it shows - a new version is a new page. Its
 * header's widgets go to the host's page header (`headerTarget`), its
 * footer's to the host's pinned footer (`footerTarget`).
 */
import { PAGE_FOOTER_SLOT, PAGE_HEADER_SLOT } from '@totalbase/tb-catalog'
import type { DataView, DataViewField } from '~/types/dataview'
import { useCustomPage, WIDGET_RUNTIME_KEY, type WidgetRuntime } from '~/composables/useWidgetRuntime'
import { areaWidgets, widgetCellClass, widgetCellStyle } from '~/utils/widget-layout'
import WidgetRenderer from '~/components/WidgetRenderer.vue'

const props = defineProps<{
  dataview: DataView
  fields: DataViewField[]
  /** URL parameters a Value's default may read. */
  params?: Record<string, unknown>
  /** The record opens read-only until edit() - a FORM's READ mode. */
  recordView?: boolean
  /** The Design form's Preview: a Call asks before it runs - it writes for real; the record reads the draft's table. */
  preview?: boolean
  /** Where in the host's page header its header widgets go (a selector); without one they show above the page, at the right. */
  headerTarget?: string
  /** Where its footer widgets go - the host's pinned footer (a selector); without one they stick to the bottom of what scrolls the page. */
  footerTarget?: string
}>()

const emit = defineEmits<{
  close: []
  /** Started - the host (a record form's page) drives the record from here on. */
  ready: [runtime: WidgetRuntime]
}>()

const { runtime, start, dialogs, codeError } = useCustomPage(toRef(props, 'dataview'), toRef(props, 'fields'), {
  params: props.params,
  preview: props.preview,
  onClose: props.preview ? undefined : () => emit('close'),
  recordView: props.recordView
})
provide(WIDGET_RUNTIME_KEY, runtime)

const { t } = useI18n()
const isCompact = useCompactUi()
const { printBlob } = usePrintBlob()
/** Closing the confirmation any way but its button is a no. */
function confirmOpenChanged(open: boolean) {
  if (!open) dialogs.confirm?.resolve(false)
}
function closeFile() {
  if (dialogs.file) URL.revokeObjectURL(dialogs.file.url)
  dialogs.file = null
}
function downloadFile() {
  if (!dialogs.file) return
  const link = document.createElement('a')
  link.href = dialogs.file.url
  link.download = dialogs.file.filename
  link.click()
}
onBeforeUnmount(closeFile)

const rootWidgets = computed(() => areaWidgets(runtime.fields.value, null, undefined))
/** Its header's buttons and menus - drawn in the host's page header. */
const headerWidgets = computed(() => areaWidgets(runtime.fields.value, null, PAGE_HEADER_SLOT))
/** Its footer's widgets - pinned under the page, laid out in its 12 columns. Nothing there, no footer. */
const footerWidgets = computed(() => areaWidgets(runtime.fields.value, null, PAGE_FOOTER_SLOT))
onMounted(async () => {
  await start()
  emit('ready', runtime)
})
</script>

<template>
  <div class="flex flex-col gap-4">
    <UAlert
      v-if="codeError"
      color="error"
      variant="subtle"
      icon="i-lucide-code"
      :title="t('designer.customPage.codeError')"
      :description="codeError"
    />
    <!-- defer: the host's header is drawn in the same pass as the page. -->
    <Teleport
      v-if="headerWidgets.length"
      :to="headerTarget"
      :disabled="!headerTarget"
      defer
    >
      <div class="flex items-center justify-end gap-2">
        <WidgetRenderer
          v-for="widget in headerWidgets"
          :key="widget.id"
          :field="widget"
        />
      </div>
    </Teleport>
    <div
      v-if="rootWidgets.length"
      class="widget-area widget-area--live"
    >
      <WidgetRenderer
        v-for="widget in rootWidgets"
        :key="widget.id"
        :field="widget"
        :class="widgetCellClass(widget)"
        :style="widgetCellStyle(widget)"
      />
    </div>
    <UEmpty
      v-else
      icon="i-lucide-layout-panel-left"
      :title="t('designer.customPage.emptyTitle')"
      :description="t('designer.customPage.emptyDescription')"
    />
    <!-- Its footer: in the host's pinned footer - or, with none, stuck to the bottom of what scrolls the page. -->
    <Teleport
      v-if="footerWidgets.length"
      :to="footerTarget"
      :disabled="!footerTarget"
      defer
    >
      <div
        class="widget-area widget-area--live items-center"
        :class="footerTarget ? undefined : 'sticky bottom-0 z-10 border-t border-default bg-default py-3'"
      >
        <WidgetRenderer
          v-for="widget in footerWidgets"
          :key="widget.id"
          :field="widget"
          :class="widgetCellClass(widget)"
          :style="widgetCellStyle(widget)"
        />
      </div>
    </Teleport>

    <!-- dataview.confirm(): the page's own question. -->
    <UModal
      :open="dialogs.confirm !== null"
      :title="dialogs.confirm?.title"
      @update:open="confirmOpenChanged"
    >
      <template #body>
        <div class="flex flex-col gap-1.5 text-sm">
          <p
            v-for="(line, index) in dialogs.confirm?.lines ?? []"
            :key="index"
          >
            {{ line }}
          </p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="outline"
            @click="dialogs.confirm?.resolve(false)"
          />
          <UButton
            :label="dialogs.confirm?.confirm"
            :color="dialogs.confirm?.color"
            @click="dialogs.confirm?.resolve(true)"
          />
        </div>
      </template>
    </UModal>

    <!-- dataview.openFile(): a PDF or an image, to print or download. -->
    <UModal
      :open="dialogs.file !== null"
      :title="dialogs.file?.filename"
      :fullscreen="isCompact"
      class="sm:max-w-2xl"
      @update:open="(open: boolean) => !open && closeFile()"
    >
      <template #body>
        <iframe
          v-if="dialogs.file"
          :src="dialogs.file.url"
          :title="dialogs.file.filename"
          class="h-[70vh] w-full rounded-md border border-default"
        />
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            :label="t('common.download')"
            icon="i-lucide-download"
            color="neutral"
            variant="outline"
            @click="downloadFile"
          />
          <UButton
            :label="t('common.close')"
            color="neutral"
            variant="outline"
            @click="closeFile"
          />
          <UButton
            :label="t('designer.customPage.print')"
            icon="i-lucide-printer"
            @click="dialogs.file && printBlob(dialogs.file.blob)"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
