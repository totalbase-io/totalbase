<script setup lang="ts">
/**
 * "New template" from TemplatesTree.vue: kind + name/description/slug in
 * one small modal (not a wizard - it's one choice plus the standard
 * NameSlugFields triple). Submitting creates the row right away with
 * blank content; the caller then opens its editor page, so from there on
 * "new" and "edit" are the same page editing the same real record.
 */
import { placeholder } from '~/utils/system-emails'
import { BLANK_PDF_CONTENT, TEMPLATE_KINDS, type TemplateKind, type TemplateSummary } from '~/utils/templates'

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ created: [TemplateSummary] }>()

const templatesApi = useTemplatesApi()
const { t } = useI18n()
const notifyError = useErrorToast()

const kind = ref<TemplateKind>('MAILING')
const identity = ref({ name: '', description: null as string | null, slug: '', slugTouched: false })
const creating = ref(false)

const kindItems = computed(() => TEMPLATE_KINDS.map(k => ({
  label: t(`content.templates.kinds.${k}.label`),
  description: t(`content.templates.kinds.${k}.description`, { example: placeholder('variable') }),
  value: k
})))

const valid = computed(() => identity.value.name.trim().length > 0 && identity.value.slug.trim().length > 0)

watch(open, (isOpen) => {
  if (!isOpen) return
  kind.value = 'MAILING'
  identity.value = { name: '', description: null, slug: '', slugTouched: false }
})

async function create() {
  if (!valid.value) return
  creating.value = true
  try {
    const created = await templatesApi.create({
      name: identity.value.name,
      description: identity.value.description,
      slug: identity.value.slug,
      kind: kind.value,
      content: kind.value === 'MAILING' ? { subject: '', message: '' } : BLANK_PDF_CONTENT,
      default_cc: [],
      default_bcc: []
    })
    open.value = false
    emit('created', created)
  } catch (err) {
    notifyError(err, t('content.templates.newModal.createError'))
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('content.templates.newTemplate')"
    :description="t('content.templates.newModal.description')"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <UFormField
          :label="t('common.type')"
          required
        >
          <URadioGroup
            v-model="kind"
            :items="kindItems"
            value-key="value"
            variant="card"
          />
        </UFormField>
        <NameSlugFields
          v-model:name="identity.name"
          v-model:description="identity.description"
          v-model:slug="identity.slug"
          v-model:slug-touched="identity.slugTouched"
        />
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          :label="t('common.cancel')"
          color="neutral"
          variant="ghost"
          :disabled="creating"
          @click="open = false"
        />
        <UButton
          :label="t('common.create')"
          :loading="creating"
          :disabled="!valid"
          @click="create"
        />
      </div>
    </template>
  </UModal>
</template>
