<script setup lang="ts">
/**
 * "Duplicate role" (Security.md §9.5): a copy under a new name - the same role for another site. An
 * administrator's copy (the Admin API) keeps capabilities and managers too; a manager's (the App API, a role
 * they manage) keeps its grants and object access only. Never its members. Opens the copy once made.
 */
const props = defineProps<{ roleId: string, roleName: string, delegated: boolean }>()
const open = defineModel<boolean>('open', { required: true })

const adminApi = useAdminApi()
const appApi = useAppApi()
const { t } = useI18n()
const toast = useToast()
const notifyError = useErrorToast()

const name = ref('')
const saving = ref(false)
watch(open, (isOpen) => {
  if (isOpen) name.value = t('users.duplicateRole.defaultName', { name: props.roleName })
})

async function submit() {
  if (!name.value.trim()) return
  saving.value = true
  try {
    const api = props.delegated ? appApi : adminApi
    const { data } = await api.post<{ id: string }>(`/roles/${props.roleId}/duplicate`, { data: { name: name.value.trim() } })
    open.value = false
    toast.add({ title: t('users.duplicateRole.done'), color: 'success' })
    await refreshNuxtData(['roles-all', 'role-options'])
    await navigateTo(`/roles/${data.id}`)
  } catch (err) {
    notifyError(err, t('users.duplicateRole.error'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('users.duplicateRole.title')"
    :description="delegated ? t('users.duplicateRole.descriptionDelegated') : t('users.duplicateRole.description')"
  >
    <template #body>
      <UFormField
        :label="t('common.name')"
        required
      >
        <UInput
          v-model="name"
          class="w-full"
          autofocus
          @keyup.enter="submit"
        />
      </UFormField>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          :label="t('common.cancel')"
          color="neutral"
          variant="outline"
          @click="open = false"
        />
        <UButton
          :label="t('users.duplicateRole.confirm')"
          :loading="saving"
          :disabled="!name.trim()"
          @click="submit"
        />
      </div>
    </template>
  </UModal>
</template>
