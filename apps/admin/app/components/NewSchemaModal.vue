<script setup lang="ts">
/**
 * Smallest possible create flow - a single name field. Validation itself
 * is server-side only (packages/schema's validateIdentifier, the same
 * helper createTable's own schema/table names go through) - a bad name
 * surfaces as a toast, same as every other admin-api create flow in this
 * app, rather than duplicating the identifier rule here too.
 */
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ created: [] }>()

const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()

const name = ref('')
const saving = ref(false)

watch(open, (isOpen) => {
  if (isOpen) name.value = ''
})

async function create() {
  if (!name.value.trim()) return
  saving.value = true
  try {
    await api.post('/schema', { data: { name: name.value.trim() } })
    toast.add({ title: t('database.newSchemaModal.created'), color: 'success' })
    open.value = false
    emit('created')
  } catch (err) {
    notifyError(err, t('database.newSchemaModal.createFailed'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('database.newSchemaModal.title')"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <UFormField
          :label="t('common.name')"
          :description="t('database.newSchemaModal.nameDescription')"
        >
          <InputPgIdentifier
            v-model="name"
            class="w-full"
            autofocus
            @keydown.enter="create"
          />
        </UFormField>

        <div class="flex justify-end gap-2">
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="ghost"
            :disabled="saving"
            @click="open = false"
          />
          <UButton
            :label="t('common.create')"
            :loading="saving"
            :disabled="!name.trim()"
            @click="create"
          />
        </div>
      </div>
    </template>
  </UModal>
</template>
