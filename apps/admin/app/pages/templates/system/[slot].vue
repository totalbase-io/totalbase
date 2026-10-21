<script setup lang="ts">
/**
 * One system email's editor (Templates → System, TemplatesTree.vue) - the
 * fixed messages TotalBase sends itself: invitation, password reset,
 * email verification, password changed, welcome. Unlike a MAILING
 * template these aren't rows: each is a `mail.templates.<slot>` setting
 * whose default lives in code (Administration.md §8.2), so there's no
 * create/rename/delete - only edit, and "Restore default" to drop the
 * override.
 *
 * The HTML body is edited in RichTextEditor, like a MAILING template: it
 * holds content only (semantic HTML) - the server wraps it in the fixed
 * email layout (font, width, instance footer) when sending and in Preview.
 *
 * Same header shape as the Templates editor ("⋯" menu, Unsaved badge,
 * Save) and the same unsaved-changes guard. Preview renders server-side
 * with the signed-in admin as the recipient and a sample link built from
 * the real link setting - includes unsaved changes, sends nothing.
 */
import { SYSTEM_EMAIL_VARIABLE_HELP, placeholder, type SystemEmail, type SystemEmailTemplate } from '~/utils/system-emails'
import { useApiErrorMessage } from '~/utils/api-error-message'
import { useCatalogText } from '~/utils/catalog-text'

const route = useRoute()
const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const errorMessage = useApiErrorMessage()
const notifyError = useErrorToast()
const catalogText = useCatalogText()
const slot = route.params.slot as string

const { data: email, error, refresh } = await useAsyncData(
  `system-email-${slot}`,
  () => api.get<SystemEmail>(`/system-emails/${slot}`).then(r => r.data)
)

const draft = ref<SystemEmailTemplate>({ subject: '', html: '', text: '' })
const savedJson = ref('')
function load(template: SystemEmailTemplate) {
  draft.value = { ...template }
  savedJson.value = JSON.stringify(draft.value)
}
watch(email, (value) => {
  if (value) load(value.template)
}, { immediate: true })
const dirty = computed(() => JSON.stringify(draft.value) !== savedJson.value)

// The email's name and description in the UI's language - the server's English when there's no translation.
const emailLabel = computed(() => email.value ? catalogText(`content.systemEmails.slots.${email.value.slot}.label`, email.value.label) : '')
const emailDescription = computed(() => email.value ? catalogText(`content.systemEmails.slots.${email.value.slot}.description`, email.value.description) : '')

const bodyTab = ref<'html' | 'text'>('html')

const saving = ref(false)
async function save(): Promise<boolean> {
  saving.value = true
  try {
    const { data } = await api.put<SystemEmail>(`/system-emails/${slot}`, { data: draft.value })
    email.value = data
    load(data.template)
    await refreshNuxtData('system-emails')
    toast.add({ title: t('content.systemEmails.editor.saved'), color: 'success' })
    return true
  } catch (err) {
    notifyError(err, t('content.systemEmails.editor.saveError'))
    return false
  } finally {
    saving.value = false
  }
}

// --- Restore default - drops the override; the editor reloads the
// registry default. A popover-sized decision in a modal only because it
// discards content that may have taken real work. ---
const restoreOpen = ref(false)
const restoring = ref(false)
async function restoreDefault() {
  restoring.value = true
  try {
    const { data } = await api.del<SystemEmail>(`/system-emails/${slot}`)
    email.value = data
    load(data.template)
    restoreOpen.value = false
    await refreshNuxtData('system-emails')
    toast.add({ title: t('content.systemEmails.editor.restored'), color: 'success' })
  } catch (err) {
    notifyError(err, t('content.systemEmails.editor.restoreError'))
  } finally {
    restoring.value = false
  }
}

const menuItems = computed(() => [[
  { label: t('content.systemEmails.editor.restoreMenu'), icon: 'i-lucide-rotate-ccw', disabled: !email.value?.overridden, onSelect: () => { restoreOpen.value = true } }
]])

// --- On/off for the optional notices (password changed, welcome) - saved
// right away, like any boolean setting. ---
const togglingEnabled = ref(false)
async function setEnabled(value: boolean) {
  if (!email.value?.enabledSetting) return
  togglingEnabled.value = true
  try {
    await api.patch('/settings/auth', { data: { [email.value.enabledSetting]: value } })
    await Promise.all([refresh(), refreshNuxtData('system-emails')])
  } catch (err) {
    notifyError(err, t('content.systemEmails.editor.settingError'))
  } finally {
    togglingEnabled.value = false
  }
}

// --- Variables - click to copy the placeholder. ---
async function copyVariable(name: string) {
  await navigator.clipboard.writeText(placeholder(name))
  toast.add({ title: t('content.systemEmails.editor.copiedVariable', { name: placeholder(name) }), color: 'success' })
}

// --- Preview ---
const previewOpen = ref(false)
const previewing = ref(false)

// Header secondary actions - buttons on desktop, PageHeader's "⋮" on a
// phone. Sending on/off is a toggle button, like a workflow's Enabled.
const headerActions = computed<HeaderAction[]>(() => {
  const actions: HeaderAction[] = []
  const enabled = email.value?.enabled
  if (enabled !== null && enabled !== undefined) {
    actions.push({
      label: enabled ? t('content.systemEmails.editor.sending') : t('content.templates.tree.off'),
      icon: enabled ? 'i-lucide-mail-check' : 'i-lucide-mail-x',
      color: enabled ? 'success' : 'neutral',
      loading: togglingEnabled.value,
      tooltip: enabled ? t('content.systemEmails.editor.sendingTooltip') : t('content.systemEmails.editor.offTooltip'),
      onSelect: () => setEnabled(!enabled)
    })
  }
  actions.push({ label: t('common.preview'), icon: 'i-lucide-eye', loading: previewing.value, onSelect: openPreview })
  return actions
})
const preview = ref<SystemEmailTemplate | null>(null)
const previewTab = ref<'html' | 'text'>('html')
async function openPreview() {
  previewing.value = true
  try {
    const { data } = await api.post<SystemEmailTemplate>(`/system-emails/${slot}/preview`, { data: draft.value })
    preview.value = data
    previewTab.value = data.html.trim() ? 'html' : 'text'
    previewOpen.value = true
  } catch (err) {
    notifyError(err, t('content.systemEmails.editor.previewError'))
  } finally {
    previewing.value = false
  }
}

// --- Save shortcut + unsaved-changes guard (same as the Templates editor). ---
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
</script>

<template>
  <PageShell :scroll="false">
    <template
      v-if="email"
      #header
    >
      <PageHeader
        :title="emailLabel"
        :description="emailDescription"
        icon="i-lucide-mail-check"
        height="editor"
        :actions="headerActions"
        :menu="menuItems"
      >
        <UBadge
          v-if="!email.overridden && !dirty"
          :label="t('content.systemEmails.editor.default')"
          color="neutral"
          variant="subtle"
          class="page-header__tall px-2.5 max-md:hidden"
        />
        <UBadge
          v-if="dirty"
          :label="t('content.templates.editor.unsaved')"
          color="warning"
          variant="subtle"
          class="page-header__tall px-2.5"
        />
        <UButton
          icon="i-lucide-save"
          :label="t('common.save')"
          :disabled="!dirty"
          :loading="saving"
          @click="save"
        />
      </PageHeader>
    </template>
    <UAlert
      v-if="error || !email"
      class="mt-6"
      color="error"
      variant="subtle"
      :title="t('content.systemEmails.editor.loadError')"
      :description="error instanceof AdminApiError ? errorMessage(error) : undefined"
    />
    <template v-else>
      <div class="flex min-h-0 flex-1 gap-6 pb-4">
        <div class="flex min-w-0 flex-1 flex-col gap-4">
          <UFormField
            :label="t('content.templates.mailForm.subject')"
            required
          >
            <UInput
              v-model="draft.subject"
              class="w-full"
            />
          </UFormField>

          <div class="flex min-h-0 flex-1 flex-col gap-2">
            <UTabs
              v-model="bodyTab"
              :items="[{ label: 'HTML', value: 'html' }, { label: t('content.systemEmails.editor.plainText'), value: 'text' }]"
              variant="link"
              :content="false"
            />
            <div
              v-if="bodyTab === 'html'"
              class="flex min-h-[28rem] flex-1 flex-col"
            >
              <RichTextEditor
                v-model="draft.html"
                fill
              />
            </div>
            <UTextarea
              v-else
              v-model="draft.text"
              :aria-label="t('content.systemEmails.editor.plainText')"
              :rows="18"
              autoresize
              class="w-full font-mono"
            />
            <p class="text-xs text-muted">
              {{ t('content.systemEmails.editor.bodyHelp') }}
              {{ t('content.systemEmails.editor.layoutHelp') }}
              <i18n-t
                v-if="email.hasAction"
                keypath="content.systemEmails.editor.actionRequired"
                tag="span"
                scope="global"
              >
                <template #placeholder>
                  <code v-text="placeholder('action_url')" />
                </template>
              </i18n-t>
            </p>
          </div>
        </div>

        <aside class="hidden w-72 shrink-0 flex-col gap-3 lg:flex">
          <div class="text-xs font-medium uppercase tracking-wide text-muted">
            {{ t('content.systemEmails.editor.variables') }}
          </div>
          <p class="text-xs text-muted">
            {{ t('content.systemEmails.editor.variablesHelp') }}
          </p>
          <button
            v-for="name in email.variables"
            :key="name"
            type="button"
            class="flex flex-col items-start gap-0.5 rounded-md border border-default px-3 py-2 text-left hover:bg-elevated"
            @click="copyVariable(name)"
          >
            <code
              class="text-xs text-highlighted"
              v-text="placeholder(name)"
            />
            <span class="text-xs text-muted">{{ SYSTEM_EMAIL_VARIABLE_HELP[name] ? t(SYSTEM_EMAIL_VARIABLE_HELP[name]) : '' }}</span>
          </button>
          <p
            v-if="email.hasAction"
            class="text-xs text-muted"
          >
            {{ t('content.systemEmails.editor.linkSetting') }}
          </p>
        </aside>
      </div>
    </template>

    <USlideover
      v-model:open="previewOpen"
      :title="t('common.preview')"
      :description="t('content.systemEmails.editor.previewDescription')"
      :ui="{ content: 'sm:max-w-3xl' }"
    >
      <template #body>
        <div
          v-if="preview"
          class="flex h-full flex-col gap-3"
        >
          <div class="text-sm">
            <span class="text-muted">{{ t('content.systemEmails.editor.subjectLabel') }} </span>
            <span class="font-medium">{{ preview.subject }}</span>
          </div>
          <UTabs
            v-model="previewTab"
            :items="[{ label: 'HTML', value: 'html', disabled: !preview.html.trim() }, { label: t('content.systemEmails.editor.plainText'), value: 'text', disabled: !preview.text.trim() }]"
            variant="link"
            :content="false"
          />
          <!-- sandbox with no allowances: the rendered HTML can't run
          scripts or reach the admin's origin. -->
          <iframe
            v-if="previewTab === 'html'"
            :srcdoc="preview.html"
            sandbox=""
            :title="t('content.systemEmails.editor.emailPreview')"
            class="min-h-[60vh] w-full flex-1 rounded-lg border border-default bg-white"
          />
          <pre
            v-else
            class="flex-1 whitespace-pre-wrap rounded-lg border border-default p-4 text-sm"
          >{{ preview.text }}</pre>
        </div>
      </template>
    </USlideover>

    <UModal
      v-model:open="restoreOpen"
      :title="t('content.systemEmails.editor.restoreTitle')"
      :description="t('content.systemEmails.editor.restoreDescription')"
    >
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="ghost"
            :disabled="restoring"
            @click="restoreOpen = false"
          />
          <UButton
            :label="t('content.systemEmails.editor.restore')"
            color="error"
            :loading="restoring"
            @click="restoreDefault"
          />
        </div>
      </template>
    </UModal>

    <UModal
      v-model:open="leaveOpen"
      :title="t('content.templates.editor.leaveTitle')"
      :description="t('content.systemEmails.editor.leaveDescription')"
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
