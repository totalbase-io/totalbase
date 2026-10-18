<script setup lang="ts">
/**
 * An audit entry's change as a code-review style diff, one block per field:
 * the field's name, then − the value before (red) and + the value after
 * (green), the part that changed in a stronger tone (utils/text-diff.ts). A
 * side that isn't there - a CREATE has no before, a DELETE no after - has
 * no line. A multi-line value (JSON, a long text) diffs by line. Shared by
 * the record history (RecordHistoryPanel.vue) and the Logs entry
 * (AuditEntryChanges.vue).
 */
import { diffLines, diffWords, type DiffSegment } from '~/utils/text-diff'
import type { AuditDiffRow } from '~/utils/audit-changes'

const props = defineProps<{
  rows: AuditDiffRow[]
  /** A column's title by its name (a DataView's) - shown instead of the name, the name kept as its tooltip. */
  labels?: Record<string, string>
}>()
const { t } = useI18n()

type Line = { sign: '-' | '+' | ' ', segments: DiffSegment[] } | { sign: '-' | '+', empty: true }

/** null stays null (shown as "(empty)"); an object or array reads as indented JSON. */
function asText(value: unknown): string | null {
  if (value === null) return null
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  return String(value)
}
const whole = (text: string, changed: boolean): DiffSegment[] => [{ text, changed }]

function linesOf(row: AuditDiffRow): Line[] {
  const hasOld = row.old !== undefined
  const hasNew = row.new !== undefined
  const before = hasOld ? asText(row.old) : undefined
  const after = hasNew ? asText(row.new) : undefined
  const side = (sign: '-' | '+', text: string | null | undefined, segments?: DiffSegment[]): Line[] => {
    if (text === undefined) return []
    if (text === null) return [{ sign, empty: true }]
    if (text.includes('\n')) return text.split('\n').map(line => ({ sign, segments: whole(line, false) }))
    return [{ sign, segments: segments ?? whole(text, false) }]
  }
  // Both sides text: by line when either spans several, by word otherwise.
  if (typeof before === 'string' && typeof after === 'string') {
    if (before.includes('\n') || after.includes('\n')) {
      return diffLines(before, after).map(line => ({ sign: line.sign, segments: whole(line.text, false) }))
    }
    const words = diffWords(before, after)
    return [
      ...side('-', before, words?.before ?? whole(before, true)),
      ...side('+', after, words?.after ?? whole(after, true))
    ]
  }
  return [...side('-', before), ...side('+', after)]
}

const blocks = computed(() => props.rows.map(row => ({ field: row.field, lines: linesOf(row) })))

const LINE_CLASS = { '-': 'bg-error/10', '+': 'bg-success/10', ' ': '' } as const
const SIGN_CLASS = { '-': 'text-error', '+': 'text-success', ' ': 'text-dimmed' } as const
const CHANGED_CLASS = { '-': 'rounded-sm bg-error/25', '+': 'rounded-sm bg-success/25', ' ': '' } as const
</script>

<template>
  <div class="flex flex-col gap-3">
    <div
      v-for="block in blocks"
      :key="block.field"
    >
      <p
        v-if="labels?.[block.field] && labels[block.field] !== block.field"
        class="mb-1 text-xs text-muted"
        :title="block.field"
      >
        {{ labels[block.field] }}
      </p>
      <p
        v-else
        class="mb-1 font-mono text-xs text-muted"
      >
        {{ block.field }}
      </p>
      <div class="overflow-hidden rounded-md border border-default font-mono text-xs">
        <div
          v-for="(line, index) in block.lines"
          :key="index"
          class="grid grid-cols-[1.25rem_1fr]"
          :class="LINE_CLASS[line.sign]"
        >
          <span
            class="select-none py-0.5 text-center"
            :class="SIGN_CLASS[line.sign]"
            aria-hidden="true"
          >{{ line.sign === ' ' ? '' : line.sign === '-' ? '−' : '+' }}</span>
          <span class="whitespace-pre-wrap py-0.5 pe-2 [overflow-wrap:anywhere]">
            <span class="sr-only">{{ line.sign === '-' ? t('shell.auditDiff.before') : line.sign === '+' ? t('shell.auditDiff.after') : '' }}</span>
            <span
              v-if="'empty' in line"
              class="italic text-dimmed"
            >{{ t('shell.auditDiff.empty') }}</span>
            <template v-else>
              <span
                v-for="(segment, s) in line.segments"
                :key="s"
                :class="[segment.changed ? CHANGED_CLASS[line.sign] : undefined, line.sign === ' ' ? 'text-muted' : 'text-highlighted']"
              >{{ segment.text }}</span>
            </template>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
