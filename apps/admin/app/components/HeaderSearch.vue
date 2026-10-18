<script setup lang="ts">
/**
 * A page header's search box - goes in PageHeader's `#search` slot. On
 * desktop, the input itself. On a phone, a search icon; tapping it lays
 * the input over the whole header row (PageHeader's `.page-header` is
 * the positioned ancestor) with a close button, instead of squeezing the
 * title and actions. Closing keeps the term - the icon stays highlighted
 * while one is active.
 *
 * `#trailing` goes inside the input (e.g. a Filter button). Attributes
 * (a width class) apply to the desktop input.
 */
defineOptions({ inheritAttrs: false })

const props = defineProps<{
  placeholder?: string
  label?: string
}>()
const { t } = useI18n()
const placeholderText = computed(() => props.placeholder ?? t('shell.headerSearch.placeholder'))
const labelText = computed(() => props.label ?? t('common.search'))
const model = defineModel<string>({ default: '' })

// Phone-style on a phone or a tablet, like the app shell (useCompactUi).
const isCompact = useCompactUi()
const open = ref(false)
</script>

<template>
  <template v-if="isCompact">
    <UButton
      icon="i-lucide-search"
      :color="model ? 'primary' : 'neutral'"
      :variant="model ? 'subtle' : 'ghost'"
      :aria-label="labelText"
      @click="open = true"
    />
    <div
      v-if="open"
      class="absolute inset-0 z-10 flex items-center gap-2 bg-default"
      @keydown.esc="open = false"
    >
      <UInput
        v-model="model"
        icon="i-lucide-search"
        :placeholder="placeholderText"
        :aria-label="labelText"
        autofocus
        class="min-w-0 flex-1"
      >
        <template
          v-if="$slots.trailing"
          #trailing
        >
          <slot name="trailing" />
        </template>
      </UInput>
      <UButton
        icon="i-lucide-x"
        color="neutral"
        variant="ghost"
        :aria-label="t('shell.headerSearch.close')"
        @click="open = false"
      />
    </div>
  </template>
  <UInput
    v-else
    v-model="model"
    icon="i-lucide-search"
    :placeholder="placeholderText"
    :aria-label="labelText"
    :class="$attrs.class ? undefined : 'w-56'"
    v-bind="$attrs"
  >
    <template
      v-if="$slots.trailing"
      #trailing
    >
      <slot name="trailing" />
    </template>
  </UInput>
</template>
