<script setup lang="ts">
/**
 * The DETAIL dashboard widget's body (Dashboards.md §5.15, D14): the query's first row as label /
 * value pairs - each field titled and formatted by its `columnSettings` over its presentation, as a TABLE's column
 * (utils/dashboard-widget-render.ts `tableColumns`, `formatTableCell`) - and its Image role's file on top (beside
 * them in two columns). Another file column is a link to its file. `layout` AUTO is two columns in a wide card
 * (`wide` - its host measures it), one on a phone. Purely presentational: its card handles the click.
 */
import type { DashboardQueryResult } from '~/types/dashboard'
import { fileLink, formatTableCell, isFileColumn, tableColumns, type DateDisplay, type TableColumnModel } from '~/utils/dashboard-widget-render'
import { valueLinkHref } from '~/utils/table-column-style'

const props = withDefaults(defineProps<{
  result: DashboardQueryResult
  config: Record<string, unknown>
  /** Its Columns role, but its image's column. */
  columns: string[]
  /** Its Image role's column. */
  image?: string | null
  layout?: 'AUTO' | 'ONE' | 'TWO'
  /** The card is wide enough for two columns (AUTO). */
  wide?: boolean
  dates: DateDisplay
  timezone?: string
  /** The editor's word that only the first row shows - none in the App. */
  notice?: string | null
}>(), {
  image: null,
  layout: 'AUTO',
  wide: false,
  timezone: undefined,
  notice: null
})

const row = computed(() => props.result.rows[0] ?? {})
const models = computed(() => tableColumns(props.result, props.config, props.columns))
const two = computed(() => props.layout === 'TWO' || (props.layout === 'AUTO' && props.wide))
const imageFile = computed(() => (props.image ? fileLink(props.result, row.value[props.image]) : undefined))

function text(model: TableColumnModel): string {
  return formatTableCell(row.value[model.name], model, props.dates, props.timezone)
}
/** Its Link (a URL, an email, a phone) - never on its Empty text. */
function href(model: TableColumnModel): string | null {
  const raw = row.value[model.name]
  const link = model.settings.linkType
  return link && raw !== null && raw !== undefined && text(model) ? valueLinkHref(link, text(model)) : null
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-2 overflow-y-auto">
    <p
      v-if="notice"
      class="flex items-center gap-1 text-xs text-muted"
      role="note"
    >
      <UIcon
        name="i-lucide-info"
        class="size-3.5 shrink-0"
      />
      {{ notice }}
    </p>
    <div
      class="min-h-0"
      :class="two && imageFile ? 'grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-4' : 'flex flex-col gap-3'"
    >
      <div
        v-if="imageFile"
        class="flex min-h-0 items-start justify-center"
        :class="two ? 'max-h-full' : 'h-40 shrink-0'"
      >
        <DashboardFileImage
          :file="imageFile"
          variant="fill"
        />
      </div>
      <dl
        class="grid gap-y-2"
        :class="two && !imageFile ? 'grid-cols-2 gap-x-4' : 'grid-cols-1'"
      >
        <div
          v-for="model in models"
          :key="model.name"
          class="min-w-0"
        >
          <dt class="truncate text-xs text-muted">
            {{ model.header }}
          </dt>
          <dd class="text-sm break-words text-highlighted">
            <DashboardFileImage
              v-if="isFileColumn(result, model.name) && fileLink(result, row[model.name])"
              :file="fileLink(result, row[model.name])"
              variant="link"
            />
            <a
              v-else-if="href(model)"
              :href="href(model)!"
              :target="model.settings.linkType === 'url' ? '_blank' : undefined"
              rel="noopener noreferrer"
              class="text-primary hover:underline"
              @click.stop
            >{{ text(model) }}</a>
            <template v-else>
              {{ text(model) }}
            </template>
          </dd>
        </div>
      </dl>
    </div>
  </div>
</template>
