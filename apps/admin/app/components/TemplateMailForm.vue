<script setup lang="ts">
// The mail-template editor - subject + message body, plus the send-time
// defaults a mailing from this template can inherit (cc/bcc/reply-to).
// Deliberately the same toolbar/layout as mailings.vue's compose drawer
// (Thunderbird-style Cc/Bcc/Reply-to toggles) since it's editing the
// same shape of content - just without the send-specific fields (To,
// send mode, priority, track opens) that only make sense for an actual
// mailing, not a reusable template.
//
// No default *data* here (deliberately, not an oversight): every {{variable}}
// placeholder a template references must come from the caller - the send/
// trigger request's own `data` - with no exception, so nobody invoking a
// template has to go check it first to know what's optional. A value
// that's always the same belongs written directly into the message text
// above, not in a parallel defaults blob.
export interface TemplateMailDraft {
  subject: string
  message: string
  defaultCcText: string
  defaultBccText: string
  defaultReplyTo: string
}

const model = defineModel<TemplateMailDraft>({ required: true })
const { t } = useI18n()

const showCc = ref(model.value.defaultCcText.trim().length > 0)
const showBcc = ref(model.value.defaultBccText.trim().length > 0)
const showReplyTo = ref(model.value.defaultReplyTo.trim().length > 0)
</script>

<template>
  <div class="flex-1 min-h-0 flex flex-col gap-3">
    <!-- Toolbar - every option lives here, same square-button + divider
        layout as mailings.vue's compose toolbar, so the fields below
        stay pure subject/message. -->
    <div class="flex flex-wrap items-center gap-2 shrink-0">
      <UTooltip :text="t('content.templates.mailForm.defaultCc')">
        <UButton
          label="Cc"
          :color="showCc ? 'primary' : 'neutral'"
          variant="outline"
          size="sm"
          @click="showCc = !showCc; if (!showCc) model.defaultCcText = ''"
        />
      </UTooltip>
      <UTooltip :text="t('content.templates.mailForm.defaultBcc')">
        <UButton
          label="Bcc"
          :color="showBcc ? 'primary' : 'neutral'"
          variant="outline"
          size="sm"
          @click="showBcc = !showBcc; if (!showBcc) model.defaultBccText = ''"
        />
      </UTooltip>
      <UTooltip :text="t('content.templates.mailForm.defaultReplyTo')">
        <UButton
          icon="i-lucide-reply"
          :color="showReplyTo ? 'primary' : 'neutral'"
          variant="outline"
          size="sm"
          square
          :aria-label="t('content.templates.mailForm.defaultReplyTo')"
          @click="showReplyTo = !showReplyTo; if (!showReplyTo) model.defaultReplyTo = ''"
        />
      </UTooltip>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto flex flex-col">
      <div
        v-if="showCc"
        class="flex items-center gap-2 border-b border-default py-1.5"
      >
        <span class="text-sm text-muted w-28 shrink-0">{{ t('content.templates.mailForm.defaultCc') }}</span>
        <UInput
          v-model="model.defaultCcText"
          :aria-label="t('content.templates.mailForm.defaultCc')"
          variant="none"
          class="flex-1"
        />
      </div>
      <div
        v-if="showBcc"
        class="flex items-center gap-2 border-b border-default py-1.5"
      >
        <span class="text-sm text-muted w-28 shrink-0">{{ t('content.templates.mailForm.defaultBcc') }}</span>
        <UInput
          v-model="model.defaultBccText"
          :aria-label="t('content.templates.mailForm.defaultBcc')"
          variant="none"
          class="flex-1"
        />
      </div>
      <div
        v-if="showReplyTo"
        class="flex items-center gap-2 border-b border-default py-1.5"
      >
        <span class="text-sm text-muted w-28 shrink-0">{{ t('content.templates.mailForm.replyTo') }}</span>
        <UInput
          v-model="model.defaultReplyTo"
          :aria-label="t('content.templates.mailForm.replyTo')"
          variant="none"
          class="flex-1"
        />
      </div>

      <div class="flex items-center gap-2 border-b border-default py-1.5">
        <span class="text-sm text-muted w-28 shrink-0">{{ t('content.templates.mailForm.subject') }}</span>
        <UInput
          v-model="model.subject"
          :aria-label="t('content.templates.mailForm.subject')"
          variant="outline"
          class="flex-1 font-mono text-xs"
        />
      </div>

      <div class="flex-1 min-h-0 pt-3 flex flex-col">
        <RichTextEditor
          v-model="model.message"
          fill
        />
      </div>
    </div>
  </div>
</template>
