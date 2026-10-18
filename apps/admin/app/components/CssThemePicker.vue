<script setup lang="ts">
/**
 * The ready-made themes of Settings > Appearance (utils/custom-css-themes.ts):
 * a row of thumbnails - rail, panel, content drawn in the theme's colors -
 * and a click replaces the custom CSS with the theme's. The sheet below
 * stays editable; the page's Save commits it, Cancel undoes it.
 */
import { CSS_THEMES, themeCss, themeOf } from '~/utils/custom-css-themes'

const modelValue = defineModel<string>({ required: true })
const { t } = useI18n()

const active = computed(() => themeOf(modelValue.value) ?? (modelValue.value.trim() ? null : 'default'))
function apply(key: string) {
  const theme = CSS_THEMES.find(item => item.key === key)!
  modelValue.value = theme.key === 'default' ? '' : themeCss(theme)
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <p class="text-sm text-muted">
      {{ t('settings.appearance.themes.hint') }}
    </p>
    <div class="flex flex-wrap gap-3">
      <button
        v-for="theme in CSS_THEMES"
        :key="theme.key"
        type="button"
        class="flex w-28 flex-col gap-1.5 rounded-md border p-1.5 text-left transition-colors hover:bg-elevated"
        :class="active === theme.key ? 'border-primary ring-2 ring-primary/40' : 'border-default'"
        :aria-pressed="active === theme.key"
        @click="apply(theme.key)"
      >
        <!-- The thumbnail: a rail, a panel, the content, in the theme's colors. -->
        <span
          class="flex h-14 w-full overflow-hidden rounded border border-default"
          :style="{ background: theme.swatch.content }"
        >
          <span
            class="flex w-3 flex-col items-center gap-1 pt-1"
            :style="{ background: theme.swatch.rail }"
          >
            <span
              v-for="n in 4"
              :key="n"
              class="size-1 rounded-sm"
              :style="{ background: theme.swatch.railText }"
            />
          </span>
          <span
            class="flex w-7 flex-col gap-1 border-r border-black/5 p-1"
            :style="{ background: theme.swatch.panel }"
          >
            <span
              v-for="n in 3"
              :key="n"
              class="h-0.5 w-full rounded bg-black/15"
            />
          </span>
          <span class="flex flex-1 flex-col gap-1 p-1.5">
            <span class="h-1 w-2/3 rounded bg-black/20" />
            <span class="h-0.5 w-full rounded bg-black/10" />
            <span class="h-0.5 w-5/6 rounded bg-black/10" />
          </span>
        </span>
        <span class="truncate text-xs font-medium text-highlighted">{{ t(`settings.appearance.themes.${theme.key}`) }}</span>
      </button>
    </div>
  </div>
</template>
