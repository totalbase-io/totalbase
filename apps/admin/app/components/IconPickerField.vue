<script setup lang="ts">
// Reusable icon picker: a UFormField wrapping a popover whose trigger
// shows only the current icon (no name) and whose content is a wide
// scrollable grid of icon-only buttons to pick from - built as a
// custom grid rather than USelectMenu because that component renders
// a vertical label list, not a multi-column icon grid. Generic over
// the icon list via `options`
// (defaults to ROLE_ICON_OPTIONS, the small curated set Roles has always
// used) so a caller wanting the full lucide catalog - DataViews, since
// TotalBase is growing past a handful of screens each needing their own
// icon - pass `options="lucide"` instead: the full catalog
// (utils/lucide-icon-names.ts, all 1800+ icons, ~49 KB) is imported the
// first time such a picker opens, never in the page's own bundle - an
// Edit DataView or a widget inspector mounts a dozen of these, and most
// sessions open none.
//
// Search is local substring matching against the icon's own name (no
// network call - Iconify's hosted search API has better synonym
// matching, but this is a self-hosted admin, not something that should
// depend on internet access to pick an icon) - typing "user" matches
// `user`, `user-check`, `circle-user`, etc. With a list this size,
// rendering everything unfiltered would be a slow, mostly-useless wall
// of icons, so the grid only ever shows up to MAX_RESULTS at a time -
// harmless for the ~100-icon Roles list, necessary for the full catalog.
import { DEFAULT_ROLE_ICON, ROLE_ICON_OPTIONS } from '~/types/permission'

const MAX_RESULTS = 240

const modelValue = defineModel<string | undefined>()
const props = withDefaults(defineProps<{
  label: string
  disabled?: boolean
  /** The icons offered: a list of names, or `'lucide'` for the whole lucide catalog, loaded on first open. */
  options?: readonly string[] | 'lucide'
  /**
   * Whether "no icon" is a valid choice, not just "hasn't picked one yet".
   * Roles/DataView identity (the picker's original callers) always want
   * SOME icon, so the trigger falls back to `DEFAULT_ROLE_ICON` and there
   * was never a way back to empty - fine there, but wrong for an
   * optional per-field icon (Design form's Appearance tab): once set,
   * it could never be removed again (real bug report). When true, the
   * trigger shows a dashed placeholder instead of that fallback, and a
   * "Clear" action appears once a value is set.
   */
  clearable?: boolean
  /** Help under the label, like any form field's. */
  description?: string
  /** Help in a popover at the end of the label's line instead (FieldHelp in the hint) - where fields must stay level. */
  help?: string
  /** The trigger's accessible name when `label` is empty (a row of controls with a heading above). */
  ariaLabel?: string
}>(), {
  disabled: false,
  options: () => ROLE_ICON_OPTIONS,
  clearable: false
})

const open = ref(false)
const search = ref('')
const { t } = useI18n()

/** The lucide catalog, once any picker asked for it. */
const lucideNames = shallowRef<readonly string[] | null>(null)
const catalogLoading = ref(false)
async function loadLucideCatalog() {
  if (lucideNames.value || catalogLoading.value) return
  catalogLoading.value = true
  try {
    lucideNames.value = (await import('~/utils/lucide-icon-names')).LUCIDE_ICON_NAMES
  } finally {
    catalogLoading.value = false
  }
}
const optionList = computed<readonly string[]>(() => (props.options === 'lucide' ? lucideNames.value ?? [] : props.options))

watch(open, (isOpen) => {
  if (!isOpen) {
    search.value = ''
    return
  }
  if (props.options === 'lucide') void loadLucideCatalog()
})

const filteredIcons = computed(() => {
  const term = search.value.trim().toLowerCase()
  if (!term) return optionList.value
  return optionList.value.filter(icon => icon.toLowerCase().includes(term))
})
const visibleIcons = computed(() => filteredIcons.value.slice(0, MAX_RESULTS))
const truncatedCount = computed(() => filteredIcons.value.length - visibleIcons.value.length)

function select(icon: string) {
  modelValue.value = icon
  open.value = false
}
function clear() {
  modelValue.value = undefined
  open.value = false
}
</script>

<template>
  <UFormField
    :label="label || undefined"
    :description="description"
  >
    <template
      v-if="help"
      #hint
    >
      <FieldHelp
        :text="help"
        :label="label"
      />
    </template>
    <UPopover v-model:open="open">
      <UButton
        :icon="modelValue ?? (clearable ? undefined : DEFAULT_ROLE_ICON)"
        color="neutral"
        variant="outline"
        :class="clearable && !modelValue ? 'border-dashed text-muted' : undefined"
        square
        :disabled="disabled"
        :aria-label="ariaLabel ?? label"
      >
        <UIcon
          v-if="clearable && !modelValue"
          name="i-lucide-image-off"
          class="size-4"
        />
      </UButton>
      <template #content>
        <div class="flex w-72 flex-col gap-2 p-2">
          <div class="flex items-center gap-1.5">
            <UInput
              v-model="search"
              icon="i-lucide-search"
              :placeholder="t('shell.iconPicker.search')"
              size="sm"
              autofocus
              class="w-full"
            />
            <UButton
              v-if="clearable && modelValue"
              :label="t('common.clear')"
              size="sm"
              color="neutral"
              variant="ghost"
              @click="clear"
            />
          </div>
          <div class="grid grid-cols-8 gap-1 max-h-64 overflow-y-auto">
            <button
              v-for="icon in visibleIcons"
              :key="icon"
              type="button"
              :title="icon"
              class="flex items-center justify-center rounded-md p-1.5 hover:bg-elevated"
              :class="modelValue === icon ? 'bg-primary/10 text-primary' : 'text-toned'"
              @click="select(icon)"
            >
              <UIcon
                :name="icon"
                class="size-4"
              />
            </button>
            <UEmpty
              v-if="catalogLoading"
              loading
              variant="naked"
              size="sm"
              class="col-span-8"
            />
            <p
              v-else-if="visibleIcons.length === 0"
              class="col-span-8 py-4 text-center text-xs text-muted"
            >
              {{ t('shell.iconPicker.noMatch', { search }) }}
            </p>
          </div>
          <p
            v-if="truncatedCount > 0"
            class="text-center text-xs text-muted"
          >
            {{ t('shell.iconPicker.more', { n: truncatedCount }) }}
          </p>
        </div>
      </template>
    </UPopover>
  </UFormField>
</template>
