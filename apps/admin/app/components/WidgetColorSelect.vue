<script setup lang="ts">
/**
 * `UColorSelect` adapter for a plain string COLUMN field - not a real
 * Nuxt UI component (same "the name exists only as this adapter slot"
 * convention `UJson`/`UInputDate`/etc already use,
 * WidgetRenderer.vue's own `WIDGET_COMPONENTS` doc comment).
 * The chat's own explicit call: ONE color widget instead of two
 * (`UColorPicker` for a real CSS color, a short-lived `URoleColorSelect`
 * for the app's own 17-name palette) - this replaces both. A popover
 * with two tabs:
 * - "Palette": the same 17-swatch grid `ColorPickerField.vue` already
 *   uses elsewhere (Map/Kanban/Calendar's own `defaultColor`) - stores
 *   the plain name (`"blue"`), the exact shape a `colorFormula` binding
 *   already expects.
 * - "Custom": the REAL `UColorPicker` embedded (full hue/saturation drag
 *   + a hex text input, already built - no reason to hand-roll a second
 *   one) - stores a literal hex (`format="hex"`, `isHexColor`'s own doc
 *   comment on why never `rgb(...)`/`hsl(...)` even though that
 *   component CAN emit those).
 *
 * Either shape round-trips through `roleColorShade`/`ColorDot.vue`
 * (isValidColorValue's own doc comment) exactly the same as before this
 * widget existed - a name resolves through the light/dark-aware oklch
 * table, a hex renders as-is (no such awareness for one exact, fixed
 * pick - the accepted tradeoff of "any color" freedom over a semantic
 * name).
 */
import { isHexColor, ROLE_COLOR_OPTIONS, type RoleColor } from '~/types/permission'

// `WidgetRenderer.vue` always applies its own generic
// `widgetClass(field)` (`w-full` plus any `cssClass`) to whatever it
// renders via `:is` - correct for a text input that SHOULD stretch to
// the field's full width, but not for a small square swatch button like
// this one. `inheritAttrs: false` + binding the incoming attributes
// (`useAttrs()`: its `class`, and the widget's HTML attributes - data-test,
// title) onto an OUTER wrapper div instead of the popover/button
// themselves means the wrapper still reserves the field's full width
// (consistent layout), while the button inside stays its own natural
// small size instead of stretching to fill it.
defineOptions({ inheritAttrs: false })
const attrs = useAttrs()

const modelValue = defineModel<string | null | undefined>()
withDefaults(defineProps<{
  disabled?: boolean
  /** Whether a "— None —" action shows, for a nullable column - mirrors `isClearable(field)`'s own doc comment (WidgetRenderer.vue): a NOT NULL column has no legal way back to null regardless of what a builder picks, so this stays false there. */
  clearable?: boolean
}>(), {
  disabled: false,
  clearable: false
})

const { t } = useI18n()
const open = ref(false)
const tab = ref<'palette' | 'custom'>('palette')
/** Reopens on the tab matching the CURRENT value's own shape - a hex value opens straight to Custom (the palette grid would show nothing selected there anyway), a name (or no value at all) opens to Palette, the more common case. */
watch(open, (isOpen) => {
  if (isOpen) tab.value = isHexColor(modelValue.value) ? 'custom' : 'palette'
})

function selectNamed(color: RoleColor) {
  modelValue.value = color
  open.value = false
}
/** `UColorPicker`'s own live `update:model-value` while dragging - applied immediately, same "no separate confirm step" feel every other widget here already has (a USelectMenu pick closes and applies in one step too). Empty/`undefined` (the picker's own transient state while clearing its internal input) is ignored rather than blanking the field out from under the builder mid-edit. */
function onCustomPick(hex: string | undefined) {
  if (hex) modelValue.value = hex
}
function clear() {
  modelValue.value = null
  open.value = false
}
</script>

<template>
  <div v-bind="attrs">
    <UPopover v-model:open="open">
      <UButton
        color="neutral"
        variant="outline"
        square
        :disabled="disabled"
      >
        <ColorDot
          v-if="modelValue"
          :color="modelValue"
          size="md"
        />
        <!-- No selection - a plain dashed-outline circle, same "visibly
        unset, not a real color guess" language ColorDot.vue's own
        invalid-color ring uses. -->
        <span
          v-else
          class="block size-3.5 rounded-full ring-1 ring-dashed ring-default"
        />
      </UButton>
      <template #content>
        <div class="flex flex-col gap-2 p-2 w-56">
          <div class="flex items-center justify-between gap-2">
            <UTabs
              v-model="tab"
              :items="[{ label: t('dataviews.widgetColorSelect.palette'), value: 'palette' }, { label: t('dataviews.widgetColorSelect.custom'), value: 'custom' }]"
              :content="false"
              size="xs"
              class="flex-1"
            />
            <UButton
              v-if="clearable"
              :label="t('common.none')"
              color="neutral"
              variant="ghost"
              size="xs"
              @click="clear"
            />
          </div>

          <!-- `v-if`, not `v-show` - UColorPicker (the "Custom" tab
          below) must actually UNMOUNT while Palette is showing, not
          just hide. Left mounted (`v-show`), it stays live and reacts
          to its own `:model-value` going `undefined` the moment a named
          color is picked (that value isn't hex) by resetting to its own
          internal default (`'#FFFFFF'`) and re-emitting `update:model-
          value` right back - which `onCustomPick` then applied,
          silently stomping the just-picked name back to white (the
          actual bug report this fixes). `v-if` means it only exists
          at all while its own tab is the one showing, with nothing left
          running to fire that stray emit from. -->
          <div
            v-if="tab === 'palette'"
            class="grid grid-cols-6 gap-1"
          >
            <button
              v-for="color in ROLE_COLOR_OPTIONS"
              :key="color"
              type="button"
              :title="color"
              class="flex items-center justify-center rounded-md p-1.5 hover:bg-elevated"
              :class="{ 'ring-2 ring-primary': modelValue === color }"
              @click="selectNamed(color)"
            >
              <ColorDot
                :color="color"
                size="md"
              />
            </button>
          </div>

          <div
            v-else
            class="flex justify-center py-1"
          >
            <UColorPicker
              :model-value="isHexColor(modelValue) ? modelValue : undefined"
              format="hex"
              @update:model-value="onCustomPick"
            />
          </div>
        </div>
      </template>
    </UPopover>
  </div>
</template>
