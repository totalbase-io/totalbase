<script setup lang="ts">
/**
 * One audit log entry in full - when, what, who, from where, its error,
 * SQL, row changes and raw JSON - opened from an AuditLogTable row
 * (pages/logs.vue, a user's Activity tab). `v-model` is the entry; null
 * closes it. Its pivot buttons ("All by this principal", "Same request"...)
 * emit `pivot` with the Logs filters to apply - the host decides where
 * that goes: the Logs page refilters itself, anywhere else opens Logs.
 */
import type { AuditLog } from '~/types/audit'

export type AuditLogPivot = Partial<Record<'principal' | 'event' | 'resource' | 'request_id', string>>

const selected = defineModel<AuditLog | null>({ required: true })
withDefaults(defineProps<{
  display: ReturnType<typeof useAuditLogDisplay>
  /** Offer the pivots - for a viewer who may open Logs. */
  pivots?: boolean
}>(), { pivots: true })
const emit = defineEmits<{ pivot: [patch: AuditLogPivot] }>()

const dates = useDateTimeFormat()
const { t } = useI18n()

const open = computed({
  get: () => selected.value !== null,
  set: (value: boolean) => { if (!value) selected.value = null }
})

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return '—'
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

/** A data write with a row snapshot - AuditEntryChanges renders it as a field table. */
function isRowChange(log: AuditLog): boolean {
  return ['CREATE', 'UPDATE', 'DELETE'].includes(log.action) && log.status === 'EXECUTED'
    && !!log.payload && typeof log.payload === 'object' && !Array.isArray(log.payload)
}

const rawSections = computed(() => {
  const log = selected.value
  if (!log) return []
  return [
    { label: t('audit.entry.payload'), json: jsonOrNull(log.payload) },
    { label: t('audit.entry.changes'), json: jsonOrNull(log.changes) },
    { label: t('audit.entry.where'), json: jsonOrNull(log.whereClause) },
    { label: t('audit.entry.metadata'), json: jsonOrNull(log.metadata) }
  ].filter((section): section is { label: string, json: string } => section.json !== null)
})

function jsonOrNull(value: unknown) {
  if (value === null || value === undefined) return null
  if (typeof value === 'object' && Object.keys(value).length === 0) return null
  return JSON.stringify(value, null, 2)
}
</script>

<template>
  <USlideover
    v-model:open="open"
    :title="t('audit.entry.title')"
  >
    <template #body>
      <div
        v-if="selected"
        class="flex flex-col gap-4 text-sm"
      >
        <div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3">
          <span class="text-muted">{{ t('audit.columns.time') }}</span>
          <span>{{ dates.dateTime(selected.createdAt) }}</span>
          <span class="text-muted">{{ t('audit.columns.action') }}</span>
          <span class="font-mono text-xs">{{ selected.action }}</span>
          <template v-if="auditEventName(selected)">
            <span class="text-muted">{{ t('audit.entry.event') }}</span>
            <span class="font-mono text-xs">{{ auditEventName(selected) }}</span>
          </template>
          <span class="text-muted">{{ t('common.status') }}</span>
          <UBadge
            :color="auditStatusColor(selected.status)"
            variant="subtle"
            size="sm"
            class="w-fit"
          >
            {{ t(`audit.statuses.${selected.status}`) }}
          </UBadge>
          <span class="text-muted">{{ t('audit.entry.principal') }}</span>
          <span>
            {{ display.principalLabel(selected) }}
            <span class="text-muted">· {{ selected.principalType }}</span>
          </span>
          <template v-if="selected.resource">
            <span class="text-muted">{{ t('audit.entry.resource') }}</span>
            <span class="font-mono text-xs break-all">{{ display.resourceLabel(selected) ?? selected.resource }}</span>
          </template>
          <span class="text-muted">{{ t('audit.entry.source') }}</span>
          <span>{{ selected.source }}</span>
          <span class="text-muted">IP</span>
          <span>{{ selected.ip ?? '—' }}</span>
          <template v-if="selected.userAgent">
            <span class="text-muted">{{ t('audit.entry.userAgent') }}</span>
            <span class="text-xs break-all">{{ selected.userAgent }}</span>
          </template>
          <span class="text-muted">{{ t('audit.entry.duration') }}</span>
          <span>{{ formatDuration(selected.durationMs) }}</span>
          <span class="text-muted">{{ t('audit.entry.requestId') }}</span>
          <span class="font-mono text-xs break-all">{{ selected.requestId }}</span>
        </div>

        <div
          v-if="pivots"
          class="flex flex-wrap gap-2"
        >
          <UButton
            v-if="selected.principalId"
            :label="t('audit.entry.allByPrincipal')"
            icon="i-lucide-user-search"
            color="neutral"
            variant="outline"
            size="xs"
            @click="emit('pivot', { principal: selected.principalId })"
          />
          <UButton
            v-if="auditEventName(selected)"
            :label="t('audit.entry.allOfEvent')"
            icon="i-lucide-filter"
            color="neutral"
            variant="outline"
            size="xs"
            @click="emit('pivot', { event: auditEventName(selected)! })"
          />
          <UButton
            v-if="selected.resource"
            :label="t('audit.entry.allOnResource')"
            icon="i-lucide-table"
            color="neutral"
            variant="outline"
            size="xs"
            @click="emit('pivot', { resource: selected.resource })"
          />
          <UButton
            :label="t('audit.entry.sameRequest')"
            icon="i-lucide-link"
            color="neutral"
            variant="outline"
            size="xs"
            @click="emit('pivot', { request_id: selected.requestId })"
          />
        </div>

        <UAlert
          v-if="selected.errorMessage || selected.errorCode"
          :color="auditStatusColor(selected.status)"
          variant="subtle"
          :title="selected.errorMessage ?? selected.errorCode ?? t('audit.entry.error')"
        >
          <template #description>
            <div class="flex flex-col gap-1 text-xs">
              <span v-if="selected.errorCode">{{ t('audit.entry.code') }} <span class="font-mono">{{ selected.errorCode }}</span></span>
              <span v-if="selected.sqlstate">SQLSTATE: <span class="font-mono">{{ selected.sqlstate }}</span></span>
              <span v-if="selected.errorDetail">{{ t('audit.entry.detail', { detail: selected.errorDetail }) }}</span>
              <span v-if="selected.errorHint">{{ t('audit.entry.hint', { hint: selected.errorHint }) }}</span>
            </div>
          </template>
        </UAlert>

        <div v-if="selected.sqlText">
          <p class="text-muted mb-1">
            SQL
          </p>
          <pre class="text-xs font-mono whitespace-pre-wrap bg-elevated rounded-md p-3 overflow-x-auto">{{ selected.sqlText }}</pre>
        </div>

        <AuditEntryChanges
          :log="selected"
          :resource="selected.resource ? display.resourceById.value.get(selected.resource) : undefined"
        />

        <!-- The stored JSON as-is. Folded away when the field table above
        already shows the row; open for everything else (an access event's
        metadata is where its detail lives). -->
        <UCollapsible
          v-if="rawSections.length"
          :key="selected.id"
          :default-open="!isRowChange(selected)"
        >
          <UButton
            :label="t('audit.entry.rawData')"
            color="neutral"
            variant="link"
            size="sm"
            trailing-icon="i-lucide-chevron-down"
            class="p-0 group"
            :ui="{ trailingIcon: 'group-data-[state=open]:rotate-180 transition-transform' }"
          />
          <template #content>
            <div class="flex flex-col gap-4 pt-3">
              <div
                v-for="section in rawSections"
                :key="section.label"
              >
                <p class="text-muted mb-1">
                  {{ section.label }}
                </p>
                <pre class="text-xs font-mono whitespace-pre-wrap bg-elevated rounded-md p-3 overflow-x-auto">{{ section.json }}</pre>
              </div>
            </div>
          </template>
        </UCollapsible>
      </div>
    </template>
  </USlideover>
</template>
