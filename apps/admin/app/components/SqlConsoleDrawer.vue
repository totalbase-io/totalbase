<script setup lang="ts">
import type { SqlExecuteResult } from '~/types/sql-console'

// A shared drawer, opened with a different intent depending on the
// caller: "create" from Resources' New resource button (blank editor),
// "edit" from a View/Function row's Edit action (pre-filled with its
// current DDL, re-running it is a CREATE OR REPLACE), "console" from the
// standalone SQL Console screen (free-form, no DDL/resource framing at
// all). The header reflects whichever one it was actually opened for,
// not a fixed "New Resource" title regardless of intent.
//
// All the actual console (editor/toolbar/results/history) lives in
// SqlConsolePanel - this component is just the drawer chrome around it,
// so /sql-console can render that same panel directly as a
// normal page instead of duplicating its own copy.
const props = withDefaults(defineProps<{
  mode?: 'create' | 'edit' | 'console'
  initialSql?: string
  editingLabel?: string
}>(), {
  mode: 'create',
  initialSql: '',
  editingLabel: ''
})

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ executed: [result: SqlExecuteResult] }>()

const { t } = useI18n()

const title = computed(() =>
  props.mode === 'edit' ? t('database.sqlConsoleDrawer.editTitle', { label: props.editingLabel }) : props.mode === 'console' ? t('database.sqlConsoleDrawer.consoleTitle') : t('database.sqlConsoleDrawer.createTitle')
)
const description = computed(() =>
  props.mode === 'edit'
    ? t('database.sqlConsoleDrawer.editDescription')
    : props.mode === 'console'
      ? t('database.sqlConsoleDrawer.consoleDescription')
      : t('database.sqlConsoleDrawer.createDescription')
)
</script>

<template>
  <AppDrawer
    v-model:open="open"
    :title="title"
    :description="description"
  >
    <SqlConsolePanel
      :initial-sql="initialSql"
      :active="open"
      class="flex-1 min-h-0"
      @executed="emit('executed', $event)"
    />
  </AppDrawer>
</template>
