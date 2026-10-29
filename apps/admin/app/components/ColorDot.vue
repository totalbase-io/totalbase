<script setup lang="ts">
// A single color swatch - the same "chip" Nuxt UI's own dashboard
// template uses for its Primary/Neutral color picker (UserMenu.vue
// there): a ring + a filled circle. Painted with roleColorShade()'s
// static oklch table, not a `--color-<name>-<shade>` CSS variable -
// this project's compiled stylesheet only carries that variable for
// the 7 colors its own utility classes reference, not the full
// palette a role's color is picked from (a class per palette color
// rendered blank - roleColorShade()'s doc comment in
// types/permission.ts has the full explanation). Deliberately not a
// UBadge/UIcon `color` prop either - those only resolve app.config.ts's
// 7 semantic aliases.
import { isValidColorValue, roleColorShade } from '~/types/permission'

const props = withDefaults(defineProps<{
  /**
   * A plain `string`, not `RoleColor` - most callers (role management,
   * ColorPickerField.vue) only ever pass a real, UI-picked one, but
   * Map/Calendar's own pin/event chips pass whatever a builder's
   * `colorFormula` (or the raw row data) actually evaluated to, which
   * can be garbage (roleColorShade's own doc comment) - or a literal hex
   * from `WidgetColorSelect.vue`'s own "Custom" tab, just as valid as a
   * palette name. `invalid` below is computed from THIS value, not
   * asked for separately, so a caller can never forget to flag one.
   */
  color: string
  size?: 'xs' | 'sm' | 'md'
}>(), {
  size: 'sm'
})

const surfaceTone = useSurfaceTone()
const { t } = useI18n()
/** Neither a real palette name nor a literal hex - `roleColorShade` itself never throws for this (falls back to `'transparent'`), but a plain transparent circle alone would just look like "no color", easy to miss. The dashed ring below is what actually tells a builder "your formula returned something, and it's wrong" apart from "no color was ever set here". */
const invalid = computed(() => !isValidColorValue(props.color))
const style = computed(() => ({
  backgroundColor: roleColorShade(props.color, surfaceTone.value)
}))

const SIZE_CLASS = { xs: 'size-2.5', sm: 'size-3.5', md: 'size-5' } as const
</script>

<template>
  <span
    class="inline-block rounded-full ring ring-bg"
    :class="[SIZE_CLASS[size], invalid ? 'ring-2 ring-dashed ring-error' : '']"
    :style="style"
    :title="invalid ? t('shell.colorDot.invalid', { color }) : undefined"
  />
</template>
