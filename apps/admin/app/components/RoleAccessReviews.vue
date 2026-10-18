<script setup lang="ts">
/**
 * A role's Access reviews tab (Specification_Security.md §1.8): the
 * attestations that someone looked at who holds it, newest first, and
 * "Record review". PostgreSQL fills in the reviewer and the members at
 * that moment; a review is never edited. `reminder`: the Administrators
 * role - a review is due once its last one is older than
 * auth.access_review_interval_days.
 */
import type { TableColumn } from '@nuxt/ui'
import type { AccessReview } from '~/composables/useRolesApi'
import { useApiErrorMessage } from '~/utils/api-error-message'

const props = defineProps<{
  roleId: string
  reminder: boolean
}>()

const rolesApi = useRolesApi()
const api = useAdminApi()
const toast = useToast()
const dates = useDateTimeFormat()
const { t } = useI18n()
const errorMessage = useApiErrorMessage()
const notifyError = useErrorToast()

const reviews = ref<AccessReview[]>([])
const loading = ref(false)
const loadError = ref<string | null>(null)
const intervalDays = ref(0)

async function load() {
  loading.value = true
  loadError.value = null
  try {
    const [rows, settings] = await Promise.all([
      rolesApi.accessReviews(props.roleId),
      props.reminder ? api.get<Record<string, unknown>>('/settings/auth').then(r => r.data) : Promise.resolve({} as Record<string, unknown>)
    ])
    reviews.value = rows
    intervalDays.value = Number(settings['auth.access_review_interval_days'] ?? 0)
  } catch (err) {
    loadError.value = errorMessage(err, t('users.accessReviews.loadError'))
  } finally {
    loading.value = false
  }
}
watch(() => props.roleId, load, { immediate: true })

const DAY_MS = 24 * 60 * 60 * 1000
/** Due: no review yet, or the last one older than the interval - only for the Administrators role, with the reminder on. */
const due = computed(() => {
  if (!props.reminder || intervalDays.value <= 0 || loading.value || loadError.value) return false
  const last = reviews.value[0]
  return !last || Date.now() - new Date(last.createdAt).getTime() > intervalDays.value * DAY_MS
})
const dueDescription = computed(() => {
  const last = reviews.value[0]
  const every = t('users.accessReviews.every', { days: intervalDays.value })
  return last ? t('users.accessReviews.lastReviewed', { date: dates.date(last.createdAt), reviewer: reviewerLabel(last), every }) : t('users.accessReviews.neverReviewed', { every })
})

function reviewerLabel(review: AccessReview): string {
  return review.reviewer ? (review.reviewer.name || review.reviewer.email) : t('users.accessReviews.deletedUser')
}

// --- Record review: a small popover anchored to its button. ---
const recordOpen = ref(false)
const outcome = ref<AccessReview['outcome']>('NO_CHANGES')
const note = ref('')
const saving = ref(false)
const OUTCOMES = computed(() => [
  { label: t('users.accessReviews.noChanges'), value: 'NO_CHANGES', description: t('users.accessReviews.noChangesDescription') },
  { label: t('users.accessReviews.changesMade'), value: 'CHANGES_MADE', description: t('users.accessReviews.changesMadeDescription') }
])

async function record() {
  saving.value = true
  try {
    await rolesApi.recordAccessReview(props.roleId, outcome.value, note.value.trim())
    recordOpen.value = false
    note.value = ''
    outcome.value = 'NO_CHANGES'
    toast.add({ title: t('users.accessReviews.recorded'), color: 'success' })
    await load()
  } catch (err) {
    notifyError(err, t('users.accessReviews.recordError'))
  } finally {
    saving.value = false
  }
}

const columns = computed<TableColumn<AccessReview>[]>(() => [
  { accessorKey: 'createdAt', header: t('users.accessReviews.reviewed') },
  { id: 'reviewer', header: t('users.accessReviews.reviewer') },
  { accessorKey: 'outcome', header: t('users.accessReviews.outcome') },
  { id: 'members', header: t('users.accessReviews.membersThen') },
  { accessorKey: 'note', header: t('users.accessReviews.note') }
])
</script>

<template>
  <div class="mx-auto flex w-full max-w-4xl flex-col gap-4 pt-4">
    <UAlert
      v-if="due"
      icon="i-lucide-calendar-clock"
      color="warning"
      variant="subtle"
      :title="t('users.accessReviews.due')"
      :description="dueDescription"
    />
    <UAlert
      v-if="loadError"
      color="error"
      variant="subtle"
      :title="loadError"
    />

    <div class="flex items-center justify-between gap-2">
      <p class="text-sm text-muted">
        {{ t('users.accessReviews.intro') }}
      </p>
      <UPopover v-model:open="recordOpen">
        <UButton
          :label="t('users.accessReviews.recordReview')"
          icon="i-lucide-clipboard-check"
        />
        <template #content>
          <div class="flex w-80 flex-col gap-3 p-4">
            <URadioGroup
              v-model="outcome"
              :items="OUTCOMES"
              :legend="t('users.accessReviews.outcome')"
            />
            <UFormField
              :label="t('users.accessReviews.note')"
              :description="t('users.accessReviews.noteDescription')"
            >
              <UTextarea
                v-model="note"
                :rows="3"
                :maxlength="1000"
                class="w-full"
              />
            </UFormField>
            <div class="flex justify-end gap-2">
              <UButton
                :label="t('common.cancel')"
                color="neutral"
                variant="ghost"
                @click="recordOpen = false"
              />
              <UButton
                :label="t('users.accessReviews.record')"
                :loading="saving"
                @click="record"
              />
            </div>
          </div>
        </template>
      </UPopover>
    </div>

    <UTable
      :data="reviews"
      :columns="columns"
      :loading="loading"
      sticky
    >
      <template #createdAt-cell="{ row }">
        {{ dates.dateTime(row.original.createdAt) }}
      </template>
      <template #reviewer-cell="{ row }">
        {{ reviewerLabel(row.original) }}
      </template>
      <template #outcome-cell="{ row }">
        <UBadge
          :label="row.original.outcome === 'NO_CHANGES' ? t('users.accessReviews.noChanges') : t('users.accessReviews.changesMade')"
          :color="row.original.outcome === 'NO_CHANGES' ? 'success' : 'warning'"
          variant="subtle"
        />
      </template>
      <template #members-cell="{ row }">
        <UTooltip
          :text="row.original.members.map(m => m.email).join(', ') || t('users.accessReviews.nobody')"
        >
          <span>{{ row.original.members.length }}</span>
        </UTooltip>
      </template>
      <template #note-cell="{ row }">
        <span class="whitespace-normal text-muted">{{ row.original.note }}</span>
      </template>
      <template #empty>
        <UEmpty
          icon="i-lucide-clipboard-check"
          :title="t('users.accessReviews.emptyTitle')"
          :description="t('users.accessReviews.emptyDescription')"
          variant="naked"
        />
      </template>
    </UTable>
  </div>
</template>
