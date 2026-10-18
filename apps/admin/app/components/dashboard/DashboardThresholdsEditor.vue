<script setup lang="ts">
/**
 * Thresholds (D5, `config.thresholds`): an ordered list - the first row the base color (no "from"), each next one a
 * color from its value up: a number, a column of the widget's row or a NUMBER/SELECT variable. Added, removed and
 * reordered; reordering keeps the first without "from" and gives the others one. An empty list is `undefined`.
 */
import type { RoleColor } from '~/types/permission'

type ValueSource = number | { column: string } | { variable: string }
interface Threshold { from?: ValueSource, color: RoleColor, label?: string }

defineProps<{
  /** The query's number columns, by name. */
  columns: string[]
  /** The dashboard's NUMBER and SELECT variables. */
  variables: { value: string, label: string }[]
}>()
const model = defineModel<Threshold[] | undefined>()
const { t } = useI18n()

const list = computed<Threshold[]>(() => (Array.isArray(model.value) ? model.value : []))
const BASE_COLORS: RoleColor[] = ['red', 'amber', 'green', 'blue', 'violet']

/** The first without "from", every next one with one - the shape's rule, kept on any change. */
function write(next: Threshold[]) {
  model.value = next.length === 0
    ? undefined
    : next.map((row, index) => {
        const { from, ...rest } = row
        if (index === 0) return rest
        return { ...rest, from: from ?? 0 }
      })
}
function update(index: number, patch: Partial<Threshold>) {
  write(list.value.map((row, i) => {
    if (i !== index) return row
    // A patched key left empty is dropped - never stored as undefined or ''.
    const merged = Object.fromEntries(Object.entries({ ...row, ...patch }).filter(([key, value]) => !(key in patch) || (value !== undefined && value !== '')))
    return merged as unknown as Threshold
  }))
}
function add() {
  const last = list.value.at(-1)?.from
  const from = typeof last === 'number' ? last + 10 : 0
  write([...list.value, { color: BASE_COLORS[list.value.length % BASE_COLORS.length]!, ...(list.value.length ? { from } : {}) }])
}
function move(index: number, by: number) {
  const next = [...list.value]
  const [row] = next.splice(index, 1)
  next.splice(index + by, 0, row!)
  write(next)
}
function remove(index: number) {
  write(list.value.filter((_, i) => i !== index))
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <p
      v-if="list.length === 0"
      class="text-xs text-muted"
    >
      {{ t('dashboards.inspector.thresholds.empty') }}
    </p>
    <div
      v-for="(row, index) in list"
      :key="index"
      class="flex flex-col gap-2 rounded-md border border-default p-2"
    >
      <p
        v-if="index === 0"
        class="text-xs text-muted"
      >
        {{ t('dashboards.inspector.thresholds.base') }}
      </p>
      <DashboardValueSource
        v-else
        :model-value="row.from"
        :label="t('dashboards.inspector.thresholds.from')"
        :columns="columns"
        :variables="variables"
        @update:model-value="(v) => update(index, { from: v as ValueSource | undefined })"
      />
      <div class="flex items-end gap-2">
        <ColorPickerField
          :model-value="row.color"
          :label="t('common.color')"
          @update:model-value="(v?: RoleColor) => v && update(index, { color: v })"
        />
        <UFormField
          :label="t('common.label')"
          class="min-w-0 flex-1"
        >
          <UInput
            :model-value="row.label ?? ''"
            :maxlength="64"
            class="w-full"
            @update:model-value="(v: string | number) => update(index, { label: String(v) })"
          />
        </UFormField>
      </div>
      <div class="flex justify-end gap-1">
        <UButton
          icon="i-lucide-arrow-up"
          color="neutral"
          variant="ghost"
          size="xs"
          :disabled="index === 0"
          :aria-label="t('dashboards.inspector.list.moveUp')"
          @click="move(index, -1)"
        />
        <UButton
          icon="i-lucide-arrow-down"
          color="neutral"
          variant="ghost"
          size="xs"
          :disabled="index === list.length - 1"
          :aria-label="t('dashboards.inspector.list.moveDown')"
          @click="move(index, 1)"
        />
        <UButton
          icon="i-lucide-trash-2"
          color="neutral"
          variant="ghost"
          size="xs"
          :aria-label="t('common.remove')"
          @click="remove(index)"
        />
      </div>
    </div>
    <div>
      <UButton
        :label="list.length ? t('dashboards.inspector.thresholds.add') : t('dashboards.inspector.thresholds.addBase')"
        icon="i-lucide-plus"
        color="neutral"
        variant="outline"
        size="xs"
        :disabled="list.length >= 10"
        @click="add"
      />
    </div>
  </div>
</template>
