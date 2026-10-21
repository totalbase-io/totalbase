<script setup lang="ts">
import WorkflowStepKeyField from '~/components/workflows/WorkflowStepKeyField.vue'
/**
 * Configures a `totalbase.send-email` node's `configuration`
 * (Workflows.md §5.16): recipients (to/cc/bcc/replyTo) and
 * either an inline message - subject plus a plain-text, HTML (RichTextEditor)
 * or both body - or a MAILING `template` rendered with `data`. Every field
 * accepts `{{stepKey.data.field}}` templates, resolved at run time. A
 * template's own `{{variable}}` placeholders are filled from `data` by the
 * server; its default cc/bcc/reply-to apply where these are left empty.
 * Attachments are File ids (or templates resolving to one), each read with
 * the executor's READ on it.
 */
export type SendEmailBodyType = 'text' | 'html' | 'both'

export interface SendEmailConfiguration {
  /** A MAILING template id - when set, subject and body come from it. */
  template?: string
  data?: Record<string, unknown>
  to?: string
  cc?: string
  bcc?: string
  replyTo?: string
  subject?: string
  bodyType?: SendEmailBodyType
  textBody?: string
  htmlBody?: string
  /** File ids, or `{{stepKey.data.asset}}` templates resolving to one. */
  attachments?: string[]
}

const props = defineProps<{ modelValue: SendEmailConfiguration, nodeKey: string, existingKeys: string[] }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ save: [{ key: string, configuration: SendEmailConfiguration }] }>()
const keyValue = ref('')
const keyValid = computed(() => keyValue.value.length > 0 && keyValue.value !== 'start' && keyValue.value !== 'item' && !props.existingKeys.includes(keyValue.value))

const to = ref('')
const showCc = ref(false)
const showBcc = ref(false)
const showReplyTo = ref(false)
const cc = ref('')
const bcc = ref('')
const replyTo = ref('')
const subject = ref('')
const bodyType = ref<SendEmailBodyType>('text')
const textBody = ref('')
const htmlBody = ref('')

type ContentMode = 'inline' | 'template'
const contentMode = ref<ContentMode>('inline')
const templateId = ref<string | undefined>(undefined)
const dataJson = ref('{}')
const dataEditor = ref<{ format: () => void } | null>(null)

const attachments = ref<string[]>([])
const filesApi = useFilesApi()
const { data: files } = useAsyncData('send-email-files', () => filesApi.listFiles(), { default: () => [] })
const fileItems = computed(() => (files.value ?? [])
  .map(f => ({ label: f.name, onSelect: () => { if (!attachments.value.includes(f.id)) attachments.value = [...attachments.value, f.id] } }))
  .sort((a, b) => a.label.localeCompare(b.label)))

const templatesApi = useTemplatesApi()
const { data: mailTemplates } = useAsyncData('send-email-templates', () =>
  templatesApi.list().then(list => list.filter(template => template.kind === 'MAILING')), { default: () => [] })
const templateOptions = computed(() => (mailTemplates.value ?? [])
  .map(template => ({ label: template.name, description: template.description ?? undefined, value: template.id }))
  .sort((a, b) => a.label.localeCompare(b.label)))

const { t } = useI18n()
const dataError = computed(() => {
  if (contentMode.value !== 'template') return null
  try {
    const parsed = JSON.parse(dataJson.value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? null : t('workflows.json.mustBeObject')
  } catch {
    return t('workflows.json.invalid')
  }
})

const BODY_TYPES = computed<Array<{ label: string, value: SendEmailBodyType }>>(() => [
  { label: t('workflows.sendEmailModal.bodyText'), value: 'text' },
  { label: 'HTML', value: 'html' },
  { label: t('workflows.sendEmailModal.bodyBoth'), value: 'both' }
])

watch(open, (value) => {
  if (!value) return
  keyValue.value = props.nodeKey
  contentMode.value = props.modelValue.template ? 'template' : 'inline'
  templateId.value = props.modelValue.template
  dataJson.value = JSON.stringify(props.modelValue.data ?? {}, null, 2)
  to.value = props.modelValue.to ?? ''
  cc.value = props.modelValue.cc ?? ''
  bcc.value = props.modelValue.bcc ?? ''
  replyTo.value = props.modelValue.replyTo ?? ''
  showCc.value = !!cc.value
  showBcc.value = !!bcc.value
  showReplyTo.value = !!replyTo.value
  subject.value = props.modelValue.subject ?? ''
  bodyType.value = props.modelValue.bodyType ?? 'text'
  textBody.value = props.modelValue.textBody ?? ''
  htmlBody.value = props.modelValue.htmlBody ?? ''
  attachments.value = [...(props.modelValue.attachments ?? [])]
})

const showTextBody = computed(() => bodyType.value === 'text' || bodyType.value === 'both')
const showHtmlBody = computed(() => bodyType.value === 'html' || bodyType.value === 'both')

const canSave = computed(() => !!to.value && keyValid.value
  && (contentMode.value === 'template' ? !!templateId.value && !dataError.value : !!subject.value))

function save() {
  const recipients = {
    to: to.value,
    cc: cc.value || undefined,
    bcc: bcc.value || undefined,
    replyTo: replyTo.value || undefined,
    attachments: attachments.value.length ? attachments.value : undefined
  }
  const configuration: SendEmailConfiguration = contentMode.value === 'template'
    ? { ...recipients, template: templateId.value, data: JSON.parse(dataJson.value) }
    : {
        ...recipients,
        subject: subject.value,
        bodyType: bodyType.value,
        textBody: showTextBody.value ? textBody.value : undefined,
        htmlBody: showHtmlBody.value ? htmlBody.value : undefined
      }
  emit('save', { key: keyValue.value, configuration })
  open.value = false
}
// A phone or tablet gets this editor fullscreen (AGENTS.md section 25, modals).
const isCompact = useCompactUi()
</script>

<template>
  <UModal
    v-model:open="open"
    :fullscreen="isCompact"
    :title="$t('workflows.sendEmailModal.sendEmail')"
    :description="$t('workflows.sendEmailModal.sendAMessage')"
    :ui="{ content: isCompact ? undefined : 'max-w-4xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <WorkflowStepKeyField
          v-model="keyValue"
          :existing-keys="existingKeys"
        />

        <UFormField
          :label="$t('workflows.sendEmailModal.to')"
          required
          :description="$t('workflows.sendEmailModal.commaSeparatedRecipientAddressesReferenc', { c0: '{{stepKey.data.field}}', c1: '{{start.data...}}' })"
        >
          <UInput
            v-model="to"
            class="w-full"
          />
        </UFormField>

        <div class="flex gap-1">
          <UButton
            v-if="!showCc"
            :label="$t('workflows.sendEmailModal.cc')"
            size="xs"
            color="neutral"
            variant="ghost"
            @click="showCc = true"
          />
          <UButton
            v-if="!showBcc"
            :label="$t('workflows.sendEmailModal.bcc')"
            size="xs"
            color="neutral"
            variant="ghost"
            @click="showBcc = true"
          />
          <UButton
            v-if="!showReplyTo"
            :label="$t('workflows.sendEmailModal.replyTo')"
            size="xs"
            color="neutral"
            variant="ghost"
            @click="showReplyTo = true"
          />
        </div>

        <UFormField
          v-if="showCc"
          :label="$t('workflows.sendEmailModal.cc')"
          :description="$t('workflows.sendEmailModal.commaSeparatedAddresses')"
        >
          <div class="flex items-center gap-2">
            <UInput
              v-model="cc"
              class="w-full"
            />
            <UButton
              :aria-label="t('common.remove')"
              icon="i-lucide-x"
              size="xs"
              color="neutral"
              variant="ghost"
              @click="showCc = false; cc = ''"
            />
          </div>
        </UFormField>

        <UFormField
          v-if="showBcc"
          :label="$t('workflows.sendEmailModal.bcc')"
          :description="$t('workflows.sendEmailModal.commaSeparatedAddresses')"
        >
          <div class="flex items-center gap-2">
            <UInput
              v-model="bcc"
              class="w-full"
            />
            <UButton
              :aria-label="t('common.remove')"
              icon="i-lucide-x"
              size="xs"
              color="neutral"
              variant="ghost"
              @click="showBcc = false; bcc = ''"
            />
          </div>
        </UFormField>

        <UFormField
          v-if="showReplyTo"
          :label="$t('workflows.sendEmailModal.replyTo')"
          :description="$t('workflows.sendEmailModal.whereRepliesToThisMessage')"
        >
          <div class="flex items-center gap-2">
            <UInput
              v-model="replyTo"
              class="w-full"
            />
            <UButton
              :aria-label="t('common.remove')"
              icon="i-lucide-x"
              size="xs"
              color="neutral"
              variant="ghost"
              @click="showReplyTo = false; replyTo = ''"
            />
          </div>
        </UFormField>

        <UFormField :label="$t('workflows.sendEmailModal.content')">
          <URadioGroup
            v-model="contentMode"
            orientation="horizontal"
            :items="[
              { label: $t('workflows.sendEmailModal.writeMessage'), value: 'inline' },
              { label: $t('workflows.sendEmailModal.useTemplate'), value: 'template' }
            ]"
          />
        </UFormField>

        <template v-if="contentMode === 'template'">
          <UFormField
            :label="$t('workflows.sendEmailModal.template')"
            required
            :description="$t('workflows.sendEmailModal.anEmailTemplateFromTemplates')"
          >
            <USelectMenu
              v-model="templateId"
              :items="templateOptions"
              value-key="value"
              class="w-full"
            />
          </UFormField>

          <UFormField
            :label="$t('workflows.sendEmailModal.data')"
            :error="dataError ?? undefined"
            :description="$t('workflows.sendEmailModal.aJsonObjectWithA', { c0: '{{variable}}', c1: '{{customer.name}}', c2: '{{stepKey.data.field}}' })"
          >
            <div class="flex items-center justify-end gap-1 pb-2">
              <UButton
                :label="$t('workflows.sendEmailModal.format')"
                icon="i-lucide-wand-sparkles"
                size="xs"
                color="neutral"
                variant="ghost"
                @click="dataEditor?.format()"
              />
            </div>
            <JsonEditor
              ref="dataEditor"
              v-model="dataJson"
              min-height="10rem"
            />
          </UFormField>
        </template>

        <template v-else>
          <UFormField
            :label="$t('workflows.sendEmailModal.subject')"
            required
          >
            <UInput
              v-model="subject"
              class="w-full"
            />
          </UFormField>

          <UFormField :label="$t('workflows.sendEmailModal.bodyType')">
            <USelect
              v-model="bodyType"
              :items="BODY_TYPES"
              value-key="value"
              class="w-40"
            />
          </UFormField>

          <UFormField
            v-if="showTextBody"
            :label="bodyType === 'both' ? $t('workflows.sendEmailModal.textBody') : $t('workflows.sendEmailModal.body')"
            :description="bodyType === 'both' ? $t('workflows.sendEmailModal.textBodyDescription') : undefined"
          >
            <UTextarea
              v-model="textBody"
              :rows="8"
              class="w-full"
            />
          </UFormField>

          <UFormField
            v-if="showHtmlBody"
            :label="bodyType === 'both' ? $t('workflows.sendEmailModal.htmlBody') : $t('workflows.sendEmailModal.body')"
          >
            <!-- Lazy: Tiptap loads when an HTML body is edited, not with the workflow editor. -->
            <LazyRichTextEditor v-model="htmlBody" />
          </UFormField>
        </template>

        <UFormField
          :label="$t('workflows.sendEmailModal.attachments')"
          :description="$t('workflows.sendEmailModal.fileIdsOrAnotherStep', { c0: '{{stepKey.data.field}}', c1: '{{create_file.data.asset}}' })"
        >
          <div class="flex items-start gap-2">
            <UInputTags
              v-model="attachments"
              class="w-full font-mono"
              :aria-label="$t('workflows.sendEmailModal.attachments')"
            />
            <UDropdownMenu
              :items="fileItems"
              :content="{ align: 'end' }"
            >
              <UButton
                :label="$t('workflows.sendEmailModal.browse')"
                color="neutral"
                variant="outline"
              />
            </UDropdownMenu>
          </div>
        </UFormField>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :label="$t('common.cancel')"
          @click="open = false"
        />
        <UButton
          :label="$t('common.save')"
          :disabled="!canSave"
          @click="save"
        />
      </div>
    </template>
  </UModal>
</template>
