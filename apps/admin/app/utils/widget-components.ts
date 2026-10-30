/**
 * The component behind every widget of the widget catalog - what the
 * renderer (WidgetRenderer.vue) mounts for a placed widget. A `Record` over
 * every `WidgetName`, so a widget added to the catalog without its component
 * fails the typecheck: what is in the catalog can always be drawn.
 *
 * Nuxt UI's components are auto-imported per literal tag, not registered
 * globally, so a dynamic `<component :is>` needs the real component object
 * (WidgetRenderer.vue's WIDGET_COMPONENTS, same reason). A few
 * inputs go through the adapters that field cell already uses - their
 * `modelValue` is a plain string/number where Nuxt UI's is reka-ui's
 * DateValue/TimeValue, a per-box array or a File. The heavy TotalBase
 * widgets (JSON, color, map, rich text, file upload, scanner, camera) load when used.
 */
import type { WidgetName } from '@totalbase/tb-catalog'
import type { Component } from 'vue'
import {
  UAccordion,
  UAlert,
  UAvatar,
  UBadge,
  UButton,
  UCard,
  UCheckbox,
  UCheckboxGroup,
  UCollapsible,
  UDropdownMenu,
  UEmpty,
  UForm,
  UFormField,
  UIcon,
  UInput,
  UInputMenu,
  UInputNumber,
  UInputRating,
  UInputTags,
  UListbox,
  UModal,
  UPopover,
  UProgress,
  URadioGroup,
  USelect,
  USelectMenu,
  UScrollArea,
  USeparator,
  USlideover,
  USlider,
  USplitter,
  USwitch,
  UTabs,
  UTextarea,
  UTooltip,
  UUser
} from '#components'
import WidgetHeading from '~/components/WidgetHeading.vue'
import WidgetBox from '~/components/WidgetBox.vue'
import WidgetTable from '~/components/WidgetTable.vue'
import WidgetInputDate from '~/components/WidgetInputDate.vue'
import WidgetInputTime from '~/components/WidgetInputTime.vue'
import WidgetPinInput from '~/components/WidgetPinInput.vue'
import WidgetText from '~/components/WidgetText.vue'

export const WIDGET_COMPONENTS: Record<WidgetName, Component> = {
  // Generic over its schema - a dynamic `<component :is>` never uses that.
  UForm: UForm as Component,
  UFormField,
  // The detail DataView's grid - loaded when a page has one.
  // Embed: another DataView or a Dashboard - loaded when a page has one.
  TDataView: defineAsyncComponent(() => import('~/components/WidgetDataView.vue')),
  TDashboard: defineAsyncComponent(() => import('~/components/WidgetDashboard.vue')),
  TFrame: defineAsyncComponent(() => import('~/components/WidgetFrame.vue')),
  TDrawer: defineAsyncComponent(() => import('~/components/WidgetDrawer.vue')),
  UInput,
  UTextarea,
  UInputNumber,
  UInputDate: WidgetInputDate,
  UInputTime: WidgetInputTime,
  USwitch,
  UCheckbox,
  USelect,
  USelectMenu,
  UInputMenu,
  URadioGroup,
  UInputTags,
  UCheckboxGroup,
  UListbox,
  UPinInput: WidgetPinInput,
  USlider,
  UInputRating,
  UFileUpload: defineAsyncComponent(() => import('~/components/WidgetFileUpload.vue')),
  // The camera and zxing-wasm load only when a page has one.
  TScanner: defineAsyncComponent(() => import('~/components/WidgetScanner.vue')),
  TCamera: defineAsyncComponent(() => import('~/components/WidgetCamera.vue')),
  TSignature: defineAsyncComponent(() => import('~/components/WidgetSignature.vue')),
  UEditor: defineAsyncComponent(() => import('~/components/WidgetEditor.vue')),
  TJson: defineAsyncComponent(() => import('~/components/WidgetJson.vue')),
  TQrCode: defineAsyncComponent(() => import('~/components/WidgetQrCode.vue')),
  TResult: defineAsyncComponent(() => import('~/components/WidgetResult.vue')),
  TColorSelect: defineAsyncComponent(() => import('~/components/WidgetColorSelect.vue')),
  TUuidInput: defineAsyncComponent(() => import('~/components/WidgetUuidInput.vue')),
  TUlidInput: defineAsyncComponent(() => import('~/components/WidgetUlidInput.vue')),
  TPasswordInput: defineAsyncComponent(() => import('~/components/WidgetPasswordInput.vue')),
  TLeafletMap: defineAsyncComponent(() => import('~/components/WidgetMap.vue')),
  TGeolocation: defineAsyncComponent(() => import('~/components/WidgetLocation.vue')),
  TRangeInput: defineAsyncComponent(() => import('~/components/WidgetRangeInput.vue')),
  TImage: defineAsyncComponent(() => import('~/components/WidgetImage.vue')),
  THeading: WidgetHeading,
  TBox: WidgetBox,
  TText: WidgetText,
  // Nuxt UI's table plus TotalBase's Search and Pager around it.
  UTable: WidgetTable,
  UBadge,
  UAlert,
  USeparator,
  UProgress,
  UAvatar,
  UUser,
  UEmpty,
  UIcon,
  UCard,
  UTabs,
  UAccordion,
  UCollapsible,
  // Generic over their items - a dynamic `<component :is>` never uses that.
  USplitter: USplitter as Component,
  UScrollArea: UScrollArea as Component,
  UModal,
  USlideover,
  UPopover,
  UTooltip,
  UDropdownMenu,
  UButton
}

/** Widgets opened by code or a trigger rather than shown in place - `dataview.controls.<name>.open()`. */
export const OVERLAY_WIDGETS: readonly WidgetName[] = ['UModal', 'USlideover', 'TDrawer']
