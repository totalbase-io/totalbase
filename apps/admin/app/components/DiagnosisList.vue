<script setup lang="ts">
/**
 * A diagnosis's issues (useDiagnosis.ts), each in the admin's words with the link that fixes it - warnings first,
 * then what is only worth knowing. Shown in a DataView's or a dashboard's header and in its publish dialog.
 */
import type { DiagnosisIssue } from '~/composables/useDiagnosis'

const props = defineProps<{
  kind: 'dataview' | 'dashboard'
  objectId: string
  issues: DiagnosisIssue[]
}>()
const { t } = useI18n()

const settings = (section: string) => `/${props.kind}s/${props.objectId}/settings?section=${section}`

function text(issue: DiagnosisIssue): string {
  const params = {
    role: issue.role?.name ?? '',
    resource: issue.resource?.name ?? '',
    columns: (issue.columns ?? []).join(', '),
    variable: issue.variable ?? '',
    actions: (issue.actions ?? []).map(a => t(`shell.diagnosis.actions.${a}`)).join(', ')
  }
  const code = issue.code === 'BROKEN_REFERENCE' && !issue.columns ? 'BROKEN_SOURCE' : issue.code
  return t(`shell.diagnosis.codes.${code}`, params)
}

function fix(issue: DiagnosisIssue): { label: string, to: string } | null {
  if (issue.code === 'NO_ROLES') return { label: t('shell.diagnosis.fixes.roles'), to: settings('security') }
  if (issue.code === 'BROKEN_REFERENCE') return { label: t('shell.diagnosis.fixes.data'), to: settings('data') }
  if (issue.code === 'CONSTRAINT_WITHOUT_MESSAGE' && issue.resource) return { label: t('shell.diagnosis.fixes.constraints'), to: `/resources/${issue.resource.id}` }
  if (issue.role) return { label: t('shell.diagnosis.fixes.permissions', { role: issue.role.name }), to: `/roles/${issue.role.id}` }
  return null
}

const groups = computed(() => [
  { key: 'warning', title: null, icon: 'i-lucide-triangle-alert', color: 'text-warning', items: props.issues.filter(i => i.severity === 'warning') },
  { key: 'info', title: t('shell.diagnosis.infoTitle'), icon: 'i-lucide-info', color: 'text-muted', items: props.issues.filter(i => i.severity === 'info') }
].filter(g => g.items.length > 0))
</script>

<template>
  <p
    v-if="issues.length === 0"
    class="text-xs text-muted"
  >
    {{ t('shell.diagnosis.none') }}
  </p>
  <div
    v-else
    class="flex flex-col gap-3"
  >
    <div
      v-for="group in groups"
      :key="group.key"
      class="flex flex-col gap-2"
    >
      <p
        v-if="group.title"
        class="text-xs font-medium text-muted"
      >
        {{ group.title }}
      </p>
      <div
        v-for="(issue, index) in group.items"
        :key="index"
        class="flex items-start gap-2 text-xs"
      >
        <UIcon
          :name="group.icon"
          :class="['mt-0.5 size-3.5 shrink-0', group.color]"
        />
        <div class="flex min-w-0 flex-col gap-0.5">
          <span>{{ text(issue) }}</span>
          <NuxtLink
            v-if="fix(issue)"
            :to="fix(issue)!.to"
            class="underline text-muted"
          >{{ fix(issue)!.label }}</NuxtLink>
        </div>
      </div>
    </div>
  </div>
</template>
