<script setup lang="ts">
/**
 * A pivot's aggregates (D17, `config.aggregates`): one row per Values column with its aggregate - sum, avg, min, max
 * or count, computed by PostgreSQL over the detail rows. Required for every value, with no default
 * (DASHBOARD_PIVOT_AGGREGATE_REQUIRED): a value without one says so in place. An aggregate whose column is no longer
 * among the Values is listed to be removed. An empty model is `undefined`.
 */
import { DASHBOARD_TOTAL_KINDS } from '@totalbase/tb-catalog'

type Aggregate = (typeof DASHBOARD_TOTAL_KINDS)[number]

const props = defineProps<{
  /** The Values columns, resolved - each needs its aggregate. */
  values: string[]
}>()
const model = defineModel<Record<string, Aggregate> | undefined>()
const { t } = useI18n()

const items = computed(() => DASHBOARD_TOTAL_KINDS.map(value => ({ value, label: t(`dashboards.inspector.total.kinds.${value}`) })))
/** Set for a column the Values no longer hold - kept until removed. */
const stale = computed(() => Object.keys(model.value ?? {}).filter(name => !props.values.includes(name)))

function set(name: string, aggregate: Aggregate | undefined) {
  const { [name]: _old, ...rest } = model.value ?? {}
  const next = aggregate ? { ...rest, [name]: aggregate } : rest
  model.value = Object.keys(next).length ? next : undefined
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <p
      v-if="values.length === 0 && stale.length === 0"
      class="text-xs text-muted"
    >
      {{ t('dashboards.inspector.aggregates.empty') }}
    </p>
    <UFormField
      v-for="name in values"
      :key="name"
      :label="name"
      :error="model?.[name] ? undefined : t('dashboards.inspector.aggregates.required')"
      required
    >
      <USelect
        :model-value="model?.[name]"
        :items="items"
        :aria-label="t('dashboards.inspector.aggregates.of', { column: name })"
        class="w-full"
        @update:model-value="(v: string) => set(name, v as Aggregate)"
      />
    </UFormField>
    <div
      v-for="name in stale"
      :key="name"
      class="flex items-center gap-1 text-sm"
    >
      <span class="min-w-0 flex-1 truncate text-muted line-through">{{ name }}</span>
      <span class="text-xs text-warning">{{ t('dashboards.inspector.aggregates.notAValue') }}</span>
      <UButton
        icon="i-lucide-x"
        color="neutral"
        variant="ghost"
        size="xs"
        :aria-label="t('dashboards.inspector.removeColumn', { column: name })"
        @click="set(name, undefined)"
      />
    </div>
  </div>
</template>
