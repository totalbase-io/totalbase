<script setup lang="ts">
// Reusable color picker: a UFormField wrapping a popover whose trigger
// shows only the current color's dot (no name) and whose content is a
// grid of dots to choose from (Nuxt UI's own dashboard template's
// color picker is the precedent). Meant for any entity that gets a RoleColor-typed column,
// not just roles - kept generic despite the type name (that palette is
// shared, not roles-specific; see types/permission.ts).
//
// `allowNone`: for a color that is optional identity (a DataView's or a
// Dashboard's), where an empty value means "no color" - shown as an empty
// dashed circle, with a "No color" choice to go back to it. Without it an
// empty value renders as DEFAULT_ROLE_COLOR, for the callers where empty
// really does mean that (a role, a map pin's default color).
import { DEFAULT_ROLE_COLOR, ROLE_COLOR_OPTIONS, type RoleColor } from '~/types/permission'

const modelValue = defineModel<RoleColor | undefined>()
withDefaults(defineProps<{
  label: string
  disabled?: boolean
  allowNone?: boolean
}>(), {
  disabled: false,
  allowNone: false
})

const open = ref(false)
const { t } = useI18n()

function select(color: RoleColor | undefined) {
  modelValue.value = color
  open.value = false
}
</script>

<template>
  <UFormField :label="label">
    <UPopover v-model:open="open">
      <UButton
        color="neutral"
        variant="outline"
        square
        :disabled="disabled"
        :aria-label="`${label}: ${modelValue ?? (allowNone ? t('shell.colorPicker.none') : DEFAULT_ROLE_COLOR)}`"
      >
        <!-- size="md" (1.25rem), matching the size UButton renders its
        own :icon prop at - IconPickerField's trigger has no default
        slot so its square sizing comes from the icon alone; this one
        needs its slotted content to match that footprint, or the two
        buttons end up visibly different sizes. -->
        <span
          v-if="allowNone && !modelValue"
          class="inline-block size-5 rounded-full border border-dashed border-accented"
          :aria-label="t('shell.colorPicker.noColor')"
        />
        <ColorDot
          v-else
          :color="modelValue ?? DEFAULT_ROLE_COLOR"
          size="md"
        />
      </UButton>
      <template #content>
        <div class="grid grid-cols-6 gap-1 p-2 w-48">
          <button
            v-if="allowNone"
            type="button"
            :title="t('shell.colorPicker.noColor')"
            :aria-label="t('shell.colorPicker.noColor')"
            class="flex items-center justify-center rounded-md p-1.5 hover:bg-elevated"
            :class="{ 'ring-2 ring-primary': !modelValue }"
            @click="select(undefined)"
          >
            <span class="inline-block size-5 rounded-full border border-dashed border-accented" />
          </button>
          <button
            v-for="color in ROLE_COLOR_OPTIONS"
            :key="color"
            type="button"
            :title="color"
            class="flex items-center justify-center rounded-md p-1.5 hover:bg-elevated"
            :class="{ 'ring-2 ring-primary': modelValue === color }"
            @click="select(color)"
          >
            <ColorDot
              :color="color"
              size="md"
            />
          </button>
        </div>
      </template>
    </UPopover>
  </UFormField>
</template>
