<script setup lang="ts">
/**
 * One template's editor, opened straight from TemplatesTree.vue - no
 * read-only step in between. The body is the kind's own editor
 * (TemplateMailForm for MAILING, PdfTemplateDesigner for PDF), embedded
 * in the page instead of the bottom drawer the old list screen used.
 *
 * Header follows the Workflows/Dashboards editor shape: object actions
 * (details, copy URL, delete) in the "⋯" menu next to the title; on the
 * right an "Unsaved" badge and Save. Name/description/slug are edited in their own
 * small modal and saved on their own - they're the row's identity, not
 * its content.
 *
 * Content saves explicitly (Save or Ctrl/Cmd+S). Leaving with unsaved
 * content - another template in the sidebar, any other route - asks first
 * (Save / Discard / Keep editing); a reload or tab close falls back to
 * the browser's own beforeunload prompt, since it can't be awaited.
 */
import type { TemplateMailDraft } from '~/components/TemplateMailForm.vue'
import { TEMPLATE_KIND_META, type TemplateSummary } from '~/utils/templates'
import { placeholder } from '~/utils/system-emails'
import { useApiErrorMessage } from '~/utils/api-error-message'

const route = useRoute()
const templatesApi = useTemplatesApi()
// A delegated user sees only the actions their permissions allow (Specification_Security.md §9.3).
const session = useSession()
const canUpdate = computed(() => session.can('templates', 'UPDATE'))
const canDelete = computed(() => session.can('templates', 'DELETE'))
const toast = useToast()
const { t } = useI18n()
const errorMessage = useApiErrorMessage()
const notifyError = useErrorToast()

const templateId = computed(() => route.params.id as string)

const { data: template, error, refresh } = await useAsyncData(
  () => `template-${templateId.value}`,
  () => templatesApi.get(templateId.value)
)

const kindMeta = computed(() => template.value ? TEMPLATE_KIND_META[template.value.kind] : null)
const kindDescription = computed(() => template.value ? t(`content.templates.kinds.${template.value.kind}.description`, { example: placeholder('variable') }) : undefined)

// --- Content draft - seeded from the loaded row. MAILING edits a plain
// reactive draft; PDF hands its content to the designer once (on mount)
// and reads it back via designerRef.getTemplate() at save time. ---
function toMailDraft(row: TemplateSummary): TemplateMailDraft {
  const content = (row.kind === 'MAILING' ? row.content ?? {} : {}) as { subject?: string, message?: string }
  return {
    subject: content.subject ?? '',
    message: content.message ?? '',
    defaultCcText: (row.defaultCc ?? []).join(', '),
    defaultBccText: (row.defaultBcc ?? []).join(', '),
    defaultReplyTo: row.defaultReplyTo ?? ''
  }
}
const mail = ref<TemplateMailDraft>(template.value ? toMailDraft(template.value) : toMailDraft({} as TemplateSummary))
const pdfContent = ref<unknown>(template.value?.kind === 'PDF' ? template.value.content : null)
const designerRef = ref<{ getTemplate: () => unknown } | null>(null)

// --- Unsaved changes. MAILING diffs the draft against what was last
// loaded/saved; PDF can't cheaply diff pdfme's template, so it relies on
// the designer's own `change` event instead. ---
const savedMailJson = ref(JSON.stringify(mail.value))
const pdfDirty = ref(false)
const dirty = computed(() => template.value?.kind === 'PDF' ? pdfDirty.value : JSON.stringify(mail.value) !== savedMailJson.value)

function splitEmails(text: string): string[] {
  return text.split(',').map(s => s.trim()).filter(Boolean)
}

const saving = ref(false)
async function save(): Promise<boolean> {
  if (!template.value) return false

  let content: unknown
  if (template.value.kind === 'MAILING') {
    content = { subject: mail.value.subject, message: mail.value.message }
  } else {
    content = designerRef.value?.getTemplate()
    if (!content) {
      toast.add({ title: t('content.templates.editor.designerNotReady'), color: 'error' })
      return false
    }
  }

  saving.value = true
  try {
    // Only the defaults that changed: each column needs its own field grant,
    // so a delegated editor allowed the content alone can still save it.
    const saved = JSON.parse(savedMailJson.value) as TemplateMailDraft
    await templatesApi.update(template.value.id, {
      content,
      ...(mail.value.defaultCcText !== saved.defaultCcText && { default_cc: splitEmails(mail.value.defaultCcText) }),
      ...(mail.value.defaultBccText !== saved.defaultBccText && { default_bcc: splitEmails(mail.value.defaultBccText) }),
      ...(mail.value.defaultReplyTo !== saved.defaultReplyTo && { default_reply_to: mail.value.defaultReplyTo || null })
    })
    savedMailJson.value = JSON.stringify(mail.value)
    pdfDirty.value = false
    toast.add({ title: t('content.templates.editor.saved'), color: 'success' })
    return true
  } catch (err) {
    notifyError(err, t('content.templates.editor.saveError'))
    return false
  } finally {
    saving.value = false
  }
}

function onKeydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    if (!saving.value) save()
  }
}
function onBeforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value) {
    event.preventDefault()
    event.returnValue = ''
  }
}
onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('beforeunload', onBeforeUnload)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('beforeunload', onBeforeUnload)
})

// In-app navigation away with unsaved content: hold it, ask, then resume
// to the same target. Registered for both leave (another route) and
// update (another template - same route record, new :id).
const pendingLeave = ref<string | null>(null)
const leaveOpen = computed({
  get: () => pendingLeave.value !== null,
  set: (open: boolean) => { if (!open) pendingLeave.value = null }
})
let bypassGuard = false
function guard(to: { fullPath: string }) {
  if (bypassGuard || !dirty.value) return true
  pendingLeave.value = to.fullPath
  return false
}
onBeforeRouteLeave(guard)
onBeforeRouteUpdate(guard)

async function resumeLeave(saveFirst: boolean) {
  const target = pendingLeave.value
  if (!target) return
  if (saveFirst && !(await save())) return
  pendingLeave.value = null
  bypassGuard = true
  await navigateTo(target)
}

// --- Details (name/description/slug) - saved on their own PATCH, then
// the sidebar is refreshed so a rename shows up there right away. ---
const detailsOpen = ref(false)
const details = ref({ name: '', description: null as string | null, slug: '', slugTouched: true })
const savingDetails = ref(false)
const detailsValid = computed(() => details.value.name.trim().length > 0 && details.value.slug.trim().length > 0)

function openDetails() {
  if (!template.value) return
  details.value = { name: template.value.name, description: template.value.description, slug: template.value.slug, slugTouched: true }
  detailsOpen.value = true
}

async function saveDetails() {
  if (!template.value || !detailsValid.value) return
  savingDetails.value = true
  try {
    await templatesApi.update(template.value.id, {
      name: details.value.name,
      description: details.value.description,
      slug: details.value.slug
    })
    detailsOpen.value = false
    await Promise.all([refresh(), refreshNuxtData('templates-tree')])
  } catch (err) {
    notifyError(err, t('content.templates.editor.saveDetailsError'))
  } finally {
    savingDetails.value = false
  }
}

// A PDF template's render route, absolute under the instance's public URL
// (AGENTS.md §19A), so what's copied works outside the admin (a curl
// command, an app's own call). Templates resolve by id, not slug (routes/
// templates.ts). An email template has no route of its own - a workflow's
// Send email step sends it - so it has nothing to copy.
async function copyUrl() {
  if (template.value?.kind !== 'PDF') return
  const base = String(session.admin.value?.publicUrl || window.location.origin).replace(/\/+$/, '')
  await navigator.clipboard.writeText(`${base}/api/totalbase/table/templates/${template.value.id}/pdf`)
  toast.add({ title: t('common.copied'), color: 'success' })
}

// --- Delete - modal with the Confirm checkbox (AGENTS.md §25), opened
// from the "⋯" menu, same as the Workflows editor. ---
const deleteOpen = ref(false)
const deleteConfirmed = ref(false)
const deleting = ref(false)
watch(deleteOpen, (isOpen) => {
  if (isOpen) deleteConfirmed.value = false
})

async function deleteTemplate() {
  if (!template.value) return
  deleting.value = true
  try {
    await templatesApi.remove(template.value.id)
    deleteOpen.value = false
    // The row is gone - its unsaved edits have nowhere to go.
    bypassGuard = true
    await refreshNuxtData('templates-tree')
    toast.add({ title: t('content.templates.editor.deleted'), color: 'success' })
    await navigateTo('/templates')
  } catch (err) {
    notifyError(err, t('content.templates.editor.deleteError'))
  } finally {
    deleting.value = false
  }
}

const objectMenuItems = computed(() => [
  [
    ...(canUpdate.value ? [{ label: t('content.templates.editor.detailsMenu'), icon: 'i-lucide-pencil', onSelect: openDetails }] : []),
    ...(template.value?.kind === 'PDF' ? [{ label: t('content.templates.editor.copyUrl'), icon: 'i-lucide-copy', onSelect: copyUrl }] : [])
  ],
  ...(canDelete.value ? [[{ label: t('common.deleteEllipsis'), icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => { deleteOpen.value = true } }]] : [])
])

// --- PDF preview - renders the designer's current (possibly unsaved)
// content server-side with each field's own sample value, and shows it in
// a sidebar: a read-only look alongside the editor (AGENTS.md §25). ---
const previewOpen = ref(false)
const previewUrl = ref<string | null>(null)
const previewing = ref(false)

async function openPreview() {
  const content = designerRef.value?.getTemplate()
  if (!content) {
    toast.add({ title: t('content.templates.editor.designerNotReady'), color: 'error' })
    return
  }
  previewing.value = true
  try {
    const blob = await templatesApi.previewPdf(content)
    if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
    previewUrl.value = URL.createObjectURL(blob)
    previewOpen.value = true
  } catch (err) {
    notifyError(err, t('content.templates.editor.previewError'))
  } finally {
    previewing.value = false
  }
}
onBeforeUnmount(() => {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
})
</script>

<template>
  <PageShell :scroll="false">
    <template
      v-if="template"
      #header
    >
      <PageHeader
        :title="template.name"
        :description="template.description ?? kindDescription"
        :icon="kindMeta?.icon"
        height="editor"
        :actions="template.kind === 'PDF' ? [{ label: t('common.preview'), icon: 'i-lucide-eye', loading: previewing, onSelect: openPreview }] : undefined"
        :menu="objectMenuItems"
      >
        <!-- Same height as the header buttons, like UnpublishedChangesBadge. -->
        <UBadge
          v-if="dirty"
          :label="t('content.templates.editor.unsaved')"
          color="warning"
          variant="subtle"
          class="page-header__tall px-2.5"
        />
        <UButton
          v-if="canUpdate"
          icon="i-lucide-save"
          :label="t('common.save')"
          :loading="saving"
          @click="save"
        />
      </PageHeader>
    </template>
    <UAlert
      v-if="error || !template"
      class="mt-6"
      color="error"
      variant="subtle"
      :title="t('content.templates.editor.loadError')"
      :description="error instanceof AdminApiError ? errorMessage(error) : undefined"
    />
    <template v-else>
      <div class="flex min-h-0 flex-1 flex-col pb-4">
        <TemplateMailForm
          v-if="template.kind === 'MAILING'"
          v-model="mail"
        />
        <PdfTemplateDesigner
          v-else
          :key="template.id"
          ref="designerRef"
          :content="pdfContent"
          @change="pdfDirty = true"
          @save="save"
        />
      </div>
    </template>

    <UModal
      v-model:open="detailsOpen"
      :title="t('content.templates.editor.detailsTitle')"
    >
      <template #body>
        <NameSlugFields
          v-model:name="details.name"
          v-model:description="details.description"
          v-model:slug="details.slug"
          v-model:slug-touched="details.slugTouched"
        />
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="ghost"
            :disabled="savingDetails"
            @click="detailsOpen = false"
          />
          <UButton
            :label="t('common.save')"
            :loading="savingDetails"
            :disabled="!detailsValid"
            @click="saveDetails"
          />
        </div>
      </template>
    </UModal>

    <USlideover
      v-model:open="previewOpen"
      :title="t('common.preview')"
      :description="t('content.templates.editor.previewDescription')"
      :ui="{ content: 'sm:max-w-3xl' }"
    >
      <template #body>
        <iframe
          v-if="previewUrl"
          :src="previewUrl"
          :title="t('content.templates.editor.pdfPreview')"
          class="h-full min-h-[70vh] w-full rounded-lg border border-default"
        />
      </template>
    </USlideover>

    <UModal
      v-model:open="deleteOpen"
      :title="t('content.templates.editor.deleteTitle')"
      :description="t('content.templates.editor.deleteDescription')"
    >
      <template #footer>
        <div class="flex w-full items-center justify-between gap-2">
          <UCheckbox
            v-model="deleteConfirmed"
            :label="t('common.confirm')"
          />
          <div class="flex gap-2">
            <UButton
              :label="t('common.cancel')"
              color="neutral"
              variant="ghost"
              :disabled="deleting"
              @click="deleteOpen = false"
            />
            <UButton
              :label="t('common.delete')"
              color="error"
              :loading="deleting"
              :disabled="!deleteConfirmed"
              @click="deleteTemplate"
            />
          </div>
        </div>
      </template>
    </UModal>

    <UModal
      v-model:open="leaveOpen"
      :title="t('content.templates.editor.leaveTitle')"
      :description="t('content.templates.editor.leaveDescription')"
    >
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            :label="t('content.templates.editor.keepEditing')"
            color="neutral"
            variant="ghost"
            :disabled="saving"
            @click="leaveOpen = false"
          />
          <UButton
            :label="t('content.templates.editor.discard')"
            color="error"
            variant="outline"
            :disabled="saving"
            @click="resumeLeave(false)"
          />
          <UButton
            :label="t('common.save')"
            :loading="saving"
            @click="resumeLeave(true)"
          />
        </div>
      </template>
    </UModal>
  </PageShell>
</template>
