<script setup lang="ts">
/**
 * The columns a project added to users (AGENTS.md §11), in a user's profile and in New user /
 * Invite - each by its presentation, a foreign key as a select of its target's rows. Values as the Data API
 * reads and writes them; `errors` - PostgreSQL's refusal (a CHECK, a foreign key, a trigger) - under the
 * column it refused.
 */
import type { UserExtraColumn } from '~/composables/useUserExtraColumns'
import { SELECT_NONE } from '~/utils/select-none'

const values = defineModel<Record<string, unknown>>({ required: true })
defineProps<{
  columns: UserExtraColumn[]
  errors?: Record<string, string>
  disabled?: boolean
}>()

function set(name: string, value: unknown) {
  values.value = { ...values.value, [name]: value }
}
/** A select's value: SELECT_NONE stands for no value (null). */
const optionValue = (name: string) => (values.value[name] === null || values.value[name] === undefined ? SELECT_NONE : String(values.value[name]))
function jsonText(name: string): string {
  const value = values.value[name]
  return value === null || value === undefined ? '' : JSON.stringify(value, null, 2)
}
function setJson(name: string, text: string) {
  try {
    set(name, text.trim() ? JSON.parse(text) : null)
  } catch {
    // Kept as typed until it parses - PostgreSQL decides on save.
  }
}
const dateValue = (name: string) => (typeof values.value[name] === 'string' ? (values.value[name] as string).slice(0, 10) : '')
const datetimeValue = (name: string) => (typeof values.value[name] === 'string' ? (values.value[name] as string).slice(0, 16) : '')
</script>

<template>
  <div class="flex flex-col gap-4">
    <UFormField
      v-for="column in columns"
      :key="column.name"
      :label="column.label"
      :description="column.help ?? undefined"
      :required="!column.nullable"
      :error="errors?.[column.name]"
    >
      <USelectMenu
        v-if="column.kind === 'options'"
        :model-value="optionValue(column.name)"
        :items="column.options ?? []"
        value-key="value"
        label-key="label"
        :search-input="(column.options?.length ?? 0) > 8"
        :disabled="disabled"
        class="w-full"
        @update:model-value="(v: string) => set(column.name, v === SELECT_NONE ? null : v)"
      />
      <USwitch
        v-else-if="column.kind === 'boolean'"
        :model-value="values[column.name] === true"
        :disabled="disabled"
        @update:model-value="(v: boolean) => set(column.name, v)"
      />
      <UInputNumber
        v-else-if="column.kind === 'number'"
        :model-value="(values[column.name] as number | null) ?? undefined"
        :disabled="disabled"
        class="w-full"
        @update:model-value="(v: number | null) => set(column.name, v ?? null)"
      />
      <UInput
        v-else-if="column.kind === 'date'"
        type="date"
        :model-value="dateValue(column.name)"
        :disabled="disabled"
        class="w-full"
        @update:model-value="(v: string) => set(column.name, v || null)"
      />
      <UInput
        v-else-if="column.kind === 'datetime'"
        type="datetime-local"
        :model-value="datetimeValue(column.name)"
        :disabled="disabled"
        class="w-full"
        @update:model-value="(v: string) => set(column.name, v || null)"
      />
      <UTextarea
        v-else-if="column.kind === 'json'"
        :model-value="jsonText(column.name)"
        :rows="3"
        :disabled="disabled"
        class="w-full font-mono"
        @update:model-value="(v: string) => setJson(column.name, v)"
      />
      <UInput
        v-else
        :model-value="values[column.name] == null ? '' : String(values[column.name])"
        :disabled="disabled"
        class="w-full"
        @update:model-value="(v: string) => set(column.name, v === '' && column.nullable ? null : v)"
      />
    </UFormField>
  </div>
</template>
