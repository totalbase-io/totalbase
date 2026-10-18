<script setup lang="ts">
/**
 * A column's look on a few real rows (Specification_DataViews.md §15.7): above its Styles and Conditions, the column's
 * first rows as a table shows them - its base style and, from the draft's conditions (sent as the Data API's `flags`,
 * so PostgreSQL decides), the one that holds for each. Read as the administrator, live as they edit.
 */
import type { ColumnPresentation } from '@totalbase/tb-catalog'
import { flattenQueryObject } from '~/utils/flatten-query-object'
import { conditionPlan, conditionStyleAttrs, rowLook } from '~/utils/column-conditions'
import { backgroundTint, setCellStyleClass } from '~/utils/table-column-style'
import { isRoleColor, roleColorShade } from '~/types/permission'

const props = defineProps<{
  resource: { schema: string, name: string, type: string }
  columnName: string
  presentation: ColumnPresentation
}>()

const { t } = useI18n()
const dataApi = useDataApi()
const colorMode = useColorMode()
const shade = (color: string) => (isRoleColor(color) ? roleColorShade(color, colorMode.value === 'dark' ? 'dark' : 'light') : undefined)

const plan = computed(() => conditionPlan([{ column: props.columnName, conditions: props.presentation.conditions }]))
const rows = ref<{ value: unknown, met: string[] }[]>([])
const failed = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
/** Read again a moment after the conditions change - not on every keystroke. */
watch([() => props.columnName, () => JSON.stringify(plan.value.flags)], () => {
  clearTimeout(timer)
  timer = setTimeout(() => void load(), 400)
}, { immediate: true })
onBeforeUnmount(() => clearTimeout(timer))

async function load() {
  try {
    const path = dataApi.resourcePath(props.resource.schema, props.resource.name, props.resource.type === 'VIEW' ? 'view' : 'table')
    const response = await dataApi.get<Record<string, unknown>[]>(path, {
      fields: props.columnName,
      limit: 4,
      ...(Object.keys(plan.value.flags).length ? flattenQueryObject(plan.value.flags, 'flags') : {})
    })
    const flags = (response as unknown as { meta?: { flags?: string[][] } }).meta?.flags
    rows.value = response.data.map((row, index) => ({ value: row[props.columnName], met: flags?.[index] ?? [] }))
    failed.value = false
  } catch {
    // A condition the database refuses (a half-written filter): the last good preview stays.
    failed.value = true
  }
}

const baseClass = computed(() => setCellStyleClass(props.presentation))
const baseStyle = computed(() => {
  const color = props.presentation.color ? shade(props.presentation.color) : undefined
  const background = props.presentation.background ? backgroundTint(shade(props.presentation.background)) : undefined
  return { ...(color ? { color } : {}), ...(background ? { backgroundColor: background } : {}) }
})
function look(met: string[]) {
  const found = rowLook(met, plan.value)
  return {
    row: found.row ? conditionStyleAttrs(found.row, shade) : null,
    cell: found.cells[props.columnName] ? { ...conditionStyleAttrs(found.cells[props.columnName]!, shade), icon: found.cells[props.columnName]!.icon, badge: found.cells[props.columnName]!.badge } : null
  }
}
const shown = (value: unknown) => (value === null || value === undefined || value === '' ? (props.presentation.emptyText ?? '—') : String(value))
</script>

<template>
  <div class="flex flex-col gap-1">
    <p class="text-xs font-semibold uppercase tracking-wide text-muted">
      {{ t('database.columnPresentationPreview.heading') }}
    </p>
    <div class="overflow-hidden rounded-md border border-default text-sm">
      <p
        v-if="rows.length === 0"
        class="px-3 py-2 text-muted"
      >
        {{ t('database.columnPresentationPreview.empty') }}
      </p>
      <div
        v-for="(row, index) in rows"
        :key="index"
        class="border-b border-default px-3 py-1.5 last:border-b-0"
        :class="look(row.met).row?.class"
        :style="look(row.met).row?.style"
      >
        <span
          :class="[baseClass, look(row.met).cell?.class, look(row.met).cell?.badge ? 'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium' : 'inline-flex items-center gap-1']"
          :style="{ ...baseStyle, ...look(row.met).cell?.style }"
        >
          <UIcon
            v-if="look(row.met).cell?.icon"
            :name="look(row.met).cell!.icon!"
            class="size-3.5 shrink-0"
          />
          {{ shown(row.value) }}
        </span>
      </div>
    </div>
    <p
      v-if="failed"
      class="text-xs text-warning"
    >
      {{ t('database.columnPresentationPreview.failed') }}
    </p>
  </div>
</template>
