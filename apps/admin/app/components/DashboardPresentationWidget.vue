<script setup lang="ts">
/**
 * A dashboard's presentation widget (Dashboards.md §5.11, D3):
 * one of the page catalog's display widgets, drawn by the same component a
 * page uses, from its `config` as a page control's - its literal `props`, and
 * its `bindings` evaluated over the dashboard's light context
 * (utils/dashboard-formula.ts: variables, the viewer, the query's rows). No
 * page runtime: nothing to edit, no Code, no events. Purely presentational
 * (AGENTS.md §21A): the card hands it the scope.
 *
 * An Image whose source is a file the query returned (`{{row.<file column>}}`,
 * §5.16, D14) shows it by the run's signed link (`files`); an embed's PRIVATE
 * file without allowFiles says it isn't available there.
 */
import { widgetDefinition, type WidgetName, type WidgetProp } from '@totalbase/tb-catalog'
import type { Component } from 'vue'
import { UAlert, UBadge, USeparator } from '#components'
import type { DashboardFileLink } from '~/types/dashboard'
import WidgetHeading from '~/components/WidgetHeading.vue'
import WidgetText from '~/components/WidgetText.vue'
import { evaluateDashboardFormula, resolveDashboardFrameUrl, type DashboardFormulaScope } from '~/utils/dashboard-formula'
import { formulaReturnType } from '~/utils/widget-formula'

const props = defineProps<{
  /** The page widget it is (its dashboard catalog entry's `page`). */
  page: WidgetName
  config: Record<string, unknown>
  scope: DashboardFormulaScope
  /** The run's files by id, their signed links (§5.16) - an Image's source among them reads its link. */
  files?: Record<string, DashboardFileLink> | null
}>()

const { t } = useI18n()

// Only the dashboard's eight - the image, QR and frame load when a dashboard has one (PROGRESS is a data widget now).
const COMPONENTS: Partial<Record<WidgetName, Component>> = {
  TImage: defineAsyncComponent(() => import('~/components/WidgetImage.vue')),
  THeading: WidgetHeading,
  TText: WidgetText,
  TQrCode: defineAsyncComponent(() => import('~/components/WidgetQrCode.vue')),
  TFrame: defineAsyncComponent(() => import('~/components/WidgetFrame.vue')),
  UBadge,
  UAlert,
  USeparator
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})

/** Its props: the literals, each formula's result over them (a binding wins), a Frame's URL filled in. */
const bound = computed(() => {
  const own: Readonly<Record<string, WidgetProp>> = widgetDefinition(props.page).props
  const out: Record<string, unknown> = { ...record(props.config.props) }
  for (const [name, binding] of Object.entries(record(props.config.bindings))) {
    const prop = own[name]
    const formula = record(binding).formula
    if (!prop || typeof formula !== 'string' || !formula.trim()) continue
    const value = evaluateDashboardFormula(formula, props.scope, formulaReturnType(prop))
    if (value !== undefined) out[name] = value
  }
  if (props.page === 'TFrame') out.url = resolveDashboardFrameUrl(typeof out.url === 'string' ? out.url : '', props.scope)
  // A file the query returned: its signed link, never the file's own route (the viewer may have no grant on it).
  const file = imageFile.value
  if (file?.url) out.src = file.url
  return out
})
/** An Image's source that is a file of the run - its link (or that it isn't served in this embed). */
const imageFile = computed(() => {
  if (props.page !== 'TImage' || !props.files) return undefined
  const binding = record(record(props.config.bindings).src).formula
  const src = typeof binding === 'string' && binding.trim() ? evaluateDashboardFormula(binding, props.scope, 'string') : record(props.config.props).src
  return typeof src === 'string' ? props.files[src.trim()] : undefined
})
// A frame fills its card; the rest sit at its top, as on a page.
const fills = computed(() => props.page === 'TFrame')
</script>

<template>
  <div
    class="w-full min-w-0"
    :class="fills ? 'h-full' : 'max-h-full overflow-y-auto'"
  >
    <p
      v-if="imageFile?.blocked"
      class="flex h-full flex-col items-center justify-center gap-1 text-center text-xs text-muted"
    >
      <UIcon
        name="i-lucide-image-off"
        class="size-5"
      />
      {{ t('dashboards.widgetView.fileBlocked') }}
    </p>
    <component
      :is="COMPONENTS[page]"
      v-else
      v-bind="bound"
    />
  </div>
</template>
