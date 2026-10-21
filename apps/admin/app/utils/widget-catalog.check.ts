/**
 * Checks the widget catalog (@totalbase/tb-catalog' WIDGET_CATALOG) against the
 * types of the component behind each widget - DataViews.md §14.1.
 * Types only, nothing runs:
 * - a catalog prop, slot or emit the component doesn't have fails `nuxi
 *   typecheck` at that widget's line, naming it (`{ unknownNames: "labell" }`);
 * - a widget with no line here fails too (`{ missingChecks: "UFoo" }`), so
 *   adding a widget to the catalog means adding its line.
 *
 * `U*` widgets are checked against the types `@nuxt/ui` exports, `T*` ones
 * against our own component's props. Lives in the admin app, not the
 * package, because both resolve only inside the Nuxt app (`#build/ui/*`).
 *
 * A component's emits come from its `XxxEmits` or, for components that have
 * none (UButton's `click`, UTable's `select`), from its `onXxx` props.
 * USlider and UFileUpload declare `modelValue` with `defineModel` inside the
 * component, outside their exported types - `WithModel` adds it for them.
 */
import type {
  AccordionEmits, AccordionProps, AccordionSlots,
  AlertEmits, AlertProps, AlertSlots,
  AvatarProps, AvatarSlots,
  BadgeProps, BadgeSlots,
  ButtonProps, ButtonSlots,
  CardProps, CardSlots,
  CheckboxEmits, CheckboxGroupEmits, CheckboxGroupProps, CheckboxGroupSlots, CheckboxProps, CheckboxSlots,
  CollapsibleEmits, CollapsibleProps, CollapsibleSlots,
  DropdownMenuEmits, DropdownMenuProps, DropdownMenuSlots,
  EditorEmits, EditorProps, EditorSlots,
  EmptyProps, EmptySlots,
  FileUploadEmits, FileUploadProps, FileUploadSlots,
  FormEmits, FormFieldProps, FormFieldSlots, FormProps, FormSlots,
  IconProps,
  InputDateEmits, InputDateProps, InputDateSlots,
  InputEmits, InputMenuEmits, InputMenuProps, InputMenuSlots, InputProps, InputSlots,
  InputNumberEmits, InputNumberProps, InputNumberSlots,
  InputRatingEmits, InputRatingProps, InputRatingSlots,
  InputTagsEmits, InputTagsProps, InputTagsSlots,
  InputTimeEmits, InputTimeProps, InputTimeSlots,
  ListboxEmits, ListboxProps, ListboxSlots,
  ModalEmits, ModalProps, ModalSlots,
  PinInputEmits, PinInputProps, PinInputSlots,
  PopoverEmits, PopoverProps, PopoverSlots,
  ProgressProps, ProgressSlots,
  RadioGroupEmits, RadioGroupProps, RadioGroupSlots,
  ScrollAreaProps, ScrollAreaSlots,
  SelectEmits, SelectMenuEmits, SelectMenuProps, SelectMenuSlots, SelectProps, SelectSlots,
  SeparatorProps, SeparatorSlots,
  SlideoverEmits, SlideoverProps, SlideoverSlots,
  SliderEmits, SliderProps,
  SplitterEmits, SplitterProps, SplitterSlots,
  SwitchEmits, SwitchProps, SwitchSlots,
  TableProps, TableSlots,
  TabsEmits, TabsProps, TabsSlots,
  TextareaEmits, TextareaProps, TextareaSlots,
  TooltipProps, TooltipSlots,
  UserProps, UserSlots
} from '@nuxt/ui'
import type { TableAction, TableColumnSettings, TableComputedColumn, WIDGET_CATALOG, WidgetName } from '@totalbase/tb-catalog'
import type { EditSize } from '~/types/dataview'
import type WidgetColorSelect from '~/components/WidgetColorSelect.vue'
import type WidgetDataView from '~/components/WidgetDataView.vue'
import type WidgetDashboard from '~/components/WidgetDashboard.vue'
import type WidgetFrame from '~/components/WidgetFrame.vue'
import type WidgetDrawer from '~/components/WidgetDrawer.vue'
import type WidgetBox from '~/components/WidgetBox.vue'
import type WidgetHeading from '~/components/WidgetHeading.vue'
import type WidgetImage from '~/components/WidgetImage.vue'
import type WidgetJson from '~/components/WidgetJson.vue'
import type WidgetResult from '~/components/WidgetResult.vue'
import type WidgetMap from '~/components/WidgetMap.vue'
import type WidgetLocation from '~/components/WidgetLocation.vue'
import type WidgetRangeInput from '~/components/WidgetRangeInput.vue'
import type WidgetTable from '~/components/WidgetTable.vue'
import type WidgetText from '~/components/WidgetText.vue'
import type WidgetQrCode from '~/components/WidgetQrCode.vue'
import type WidgetScanner from '~/components/WidgetScanner.vue'
import type WidgetCamera from '~/components/WidgetCamera.vue'
import type WidgetSignature from '~/components/WidgetSignature.vue'

type Catalog = typeof WIDGET_CATALOG

/** `onClick` → `click` - a component's events declared as props. */
type EventsFromProps<P> = { [K in keyof P]-?: K extends `on${infer E}` ? Uncapitalize<E> : never }[keyof P]
/** A component's `defineModel`: the `modelValue` prop and its `update:modelValue` event. */
type WithModel<P> = P & { 'modelValue'?: unknown, 'onUpdate:modelValue'?: unknown }
/** Our own components' props, as a template sees them. */
type OwnProps<C> = C extends abstract new (...args: never) => { $props: infer P } ? P : never

/** `true` when every name is in `Allowed`, otherwise the names that aren't. */
type Known<Names, Allowed> = [Exclude<Names, Allowed>] extends [never] ? true : { unknownNames: Exclude<Names, Allowed> }

/** Every catalog prop, slot and emit of `Name` exists on its component. */
type Check<Name extends WidgetName, P, S, E = object> = [
  Known<keyof Catalog[Name]['props'], keyof P>,
  Known<keyof Catalog[Name]['slots'], keyof S>,
  Known<keyof Catalog[Name]['emits'], keyof E | EventsFromProps<P>>
]
/** An option list's Icon field and Disabled field - TotalBase's: the renderer fills each option's `icon` and `disabled` from its row, never passes them on. */
type OptionFields = { iconKey?: string, disabledKey?: string }

/** Fails to typecheck unless the check is `true` - applied per widget: one constraint over them all reports only its first failure. */
type Assert<T extends readonly true[]> = T

// The option lists' types are generic over their items; their names aren't.
/* eslint-disable @typescript-eslint/no-explicit-any */
interface WidgetCatalogChecks {
  UForm: Assert<Check<'UForm', FormProps<any>, FormSlots, FormEmits<any>>>
  // `column`, `block`, `pattern` and `patternMessage` are TotalBase's: the renderer binds the input to the record's column, sizes it and checks its value, never passes them on.
  UFormField: Assert<Check<'UFormField', FormFieldProps & { column?: string, junction?: string, block?: boolean, pattern?: string, patternMessage?: string, labelWidth?: string }, FormFieldSlots>>
  TDataView: Assert<Check<'TDataView', OwnProps<typeof WidgetDataView>, object>>
  TDashboard: Assert<Check<'TDashboard', OwnProps<typeof WidgetDashboard>, object>>
  TFrame: Assert<Check<'TFrame', OwnProps<typeof WidgetFrame>, object>>
  TDrawer: Assert<Check<'TDrawer', OwnProps<typeof WidgetDrawer>, InstanceType<typeof WidgetDrawer>['$slots']>>
  UInput: Assert<Check<'UInput', InputProps, InputSlots, InputEmits>>
  UTextarea: Assert<Check<'UTextarea', TextareaProps, TextareaSlots, TextareaEmits>>
  UInputNumber: Assert<Check<'UInputNumber', InputNumberProps, InputNumberSlots, InputNumberEmits>>
  // `calendar` is TotalBase's: the adapter (WidgetInputDate.vue) draws the calendar button, Nuxt UI's documented pattern.
  UInputDate: Assert<Check<'UInputDate', InputDateProps & { calendar?: boolean }, InputDateSlots, InputDateEmits>>
  UInputTime: Assert<Check<'UInputTime', InputTimeProps, InputTimeSlots, InputTimeEmits>>
  USwitch: Assert<Check<'USwitch', SwitchProps, SwitchSlots, SwitchEmits>>
  UCheckbox: Assert<Check<'UCheckbox', CheckboxProps, CheckboxSlots, CheckboxEmits>>
  USelect: Assert<Check<'USelect', SelectProps & OptionFields, SelectSlots, SelectEmits<any, any, any>>>
  // `searchWindow` and `searchWindowAs` are TotalBase's: the renderer draws the 🔍 and its window - never passes them on.
  USelectMenu: Assert<Check<'USelectMenu', SelectMenuProps & OptionFields & { searchWindow?: boolean, searchWindowAs?: string, searchWindowSize?: string }, SelectMenuSlots, SelectMenuEmits<any, any, any>>>
  UInputMenu: Assert<Check<'UInputMenu', InputMenuProps & OptionFields, InputMenuSlots, InputMenuEmits<any>>>
  // `colorKey`, `iconSize` and `columns` are TotalBase's as well: the renderer colors and sizes each option's icon, and lays them out in
  // that many columns - never passes them on.
  URadioGroup: Assert<Check<'URadioGroup', RadioGroupProps & OptionFields & { colorKey?: string, iconSize?: string, columns?: string }, RadioGroupSlots, RadioGroupEmits>>
  UInputTags: Assert<Check<'UInputTags', InputTagsProps, InputTagsSlots, InputTagsEmits<any>>>
  UCheckboxGroup: Assert<Check<'UCheckboxGroup', CheckboxGroupProps & Pick<OptionFields, 'disabledKey'>, CheckboxGroupSlots, CheckboxGroupEmits>>
  UListbox: Assert<Check<'UListbox', ListboxProps & OptionFields, ListboxSlots, ListboxEmits>>
  UPinInput: Assert<Check<'UPinInput', PinInputProps, PinInputSlots, PinInputEmits>>
  USlider: Assert<Check<'USlider', WithModel<SliderProps>, object, SliderEmits>>
  UInputRating: Assert<Check<'UInputRating', InputRatingProps, InputRatingSlots, InputRatingEmits>>
  // `aspect` and `height` are TotalBase's: WidgetFileUpload frames a shown image (`preview`) in them - never passed on.
  UFileUpload: Assert<Check<'UFileUpload', WithModel<FileUploadProps> & { aspect?: string, height?: number, buttonLabel?: string }, FileUploadSlots, FileUploadEmits>>
  TScanner: Assert<Check<'TScanner', OwnProps<typeof WidgetScanner>, object>>
  TCamera: Assert<Check<'TCamera', OwnProps<typeof WidgetCamera>, object>>
  TSignature: Assert<Check<'TSignature', OwnProps<typeof WidgetSignature>, object>>
  UEditor: Assert<Check<'UEditor', EditorProps, EditorSlots, EditorEmits>>
  TJson: Assert<Check<'TJson', OwnProps<typeof WidgetJson>, object>>
  TColorSelect: Assert<Check<'TColorSelect', OwnProps<typeof WidgetColorSelect>, object>>
  TLeafletMap: Assert<Check<'TLeafletMap', OwnProps<typeof WidgetMap>, object>>
  TGeolocation: Assert<Check<'TGeolocation', OwnProps<typeof WidgetLocation>, object>>
  TRangeInput: Assert<Check<'TRangeInput', OwnProps<typeof WidgetRangeInput>, object>>
  TImage: Assert<Check<'TImage', OwnProps<typeof WidgetImage>, object>>
  THeading: Assert<Check<'THeading', OwnProps<typeof WidgetHeading>, object>>
  TBox: Assert<Check<'TBox', OwnProps<typeof WidgetBox>, InstanceType<typeof WidgetBox>['$slots']>>
  TText: Assert<Check<'TText', OwnProps<typeof WidgetText>, object>>
  TQrCode: Assert<Check<'TQrCode', OwnProps<typeof WidgetQrCode>, object>>
  TResult: Assert<Check<'TResult', OwnProps<typeof WidgetResult>, object>>
  // `columnSettings`, `computedColumns`, `rowColorKey` and `actions` are TotalBase's: the renderer builds the columns, tints
  // the rows and draws the buttons, emitting `action` itself - none reaches Nuxt UI.
  UTable: Assert<Check<'UTable', TableProps & OwnProps<typeof WidgetTable> & { columnSettings?: Record<string, TableColumnSettings>, computedColumns?: TableComputedColumn[], rowColorKey?: string, actions?: TableAction[], onAction?: (payload: { action: string, row: unknown }) => void, onSearchEnter?: (payload: { search: string, rows: unknown[], row: unknown }) => void }, TableSlots>>
  UBadge: Assert<Check<'UBadge', BadgeProps, BadgeSlots>>
  UAlert: Assert<Check<'UAlert', AlertProps, AlertSlots, AlertEmits>>
  USeparator: Assert<Check<'USeparator', SeparatorProps, SeparatorSlots>>
  UProgress: Assert<Check<'UProgress', ProgressProps, ProgressSlots>>
  UAvatar: Assert<Check<'UAvatar', AvatarProps, AvatarSlots>>
  UUser: Assert<Check<'UUser', UserProps, UserSlots>>
  UEmpty: Assert<Check<'UEmpty', EmptyProps, EmptySlots>>
  UIcon: Assert<Check<'UIcon', IconProps, object>>
  UCard: Assert<Check<'UCard', CardProps, CardSlots>>
  UTabs: Assert<Check<'UTabs', TabsProps, TabsSlots, TabsEmits>>
  UAccordion: Assert<Check<'UAccordion', AccordionProps, AccordionSlots, AccordionEmits>>
  UCollapsible: Assert<Check<'UCollapsible', CollapsibleProps, CollapsibleSlots, CollapsibleEmits>>
  USplitter: Assert<Check<'USplitter', SplitterProps, SplitterSlots, SplitterEmits>>
  UScrollArea: Assert<Check<'UScrollArea', ScrollAreaProps<any>, ScrollAreaSlots<any>>>
  // `size` is TotalBase's: the renderer turns it into the content's width (utils/overlay-size.ts), never passes it on.
  UModal: Assert<Check<'UModal', ModalProps & { size?: EditSize }, ModalSlots, ModalEmits>>
  USlideover: Assert<Check<'USlideover', SlideoverProps & { size?: EditSize }, SlideoverSlots, SlideoverEmits>>
  UPopover: Assert<Check<'UPopover', PopoverProps, PopoverSlots, PopoverEmits>>
  UTooltip: Assert<Check<'UTooltip', TooltipProps, TooltipSlots>>
  UDropdownMenu: Assert<Check<'UDropdownMenu', DropdownMenuProps, DropdownMenuSlots, DropdownMenuEmits>>
  UButton: Assert<Check<'UButton', ButtonProps, ButtonSlots>>
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Every catalog widget has its line above. */
type Complete<Missing> = [Missing] extends [never] ? true : { missingChecks: Missing }
type AssertComplete<T extends true> = T

/** Exported only so the checks are part of the typechecked program - never used. */
export type WidgetCatalogCheck = [WidgetCatalogChecks, AssertComplete<Complete<Exclude<WidgetName, keyof WidgetCatalogChecks>>>]
