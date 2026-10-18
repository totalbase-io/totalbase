<script setup lang="ts">
/**
 * From a table to a screen in one step (Specification_DataViews.md §3.1): a Table DataView over every column, the
 * roles that open it, published - so it is in the App at once. Every choice stays editable afterwards (the same
 * objects the wizard makes); **More options** opens the wizard itself. Lands on its settings, where the diagnosis
 * says what a role still lacks.
 */
import type { DataView } from '~/types/dataview'

const props = defineProps<{ resourceId: string, tableName: string }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ more: [] }>()

const { t } = useI18n()
const api = useAdminApi()
const notifyError = useErrorToast()
const { data: allRoles } = useRoleOptions()
const roles = computed(() => allRoles.value ?? [])

const name = ref('')
const roleIds = ref<string[]>([])
const publish = ref(true)
const creating = ref(false)

watch(open, (isOpen) => {
  if (!isOpen) return
  name.value = humanizeColumnName(props.tableName).slice(0, 32)
  roleIds.value = []
  publish.value = true
}, { immediate: true })

async function create() {
  creating.value = true
  try {
    const { data } = await api.post<DataView>('/dataviews', { data: { name: name.value.trim(), sourceResourceId: props.resourceId, viewType: 'TABLE' } })
    if (roleIds.value.length) await api.put(`/dataviews/${data.id}/roles`, { data: { roleIds: roleIds.value } })
    if (publish.value) await api.post(`/dataviews/${data.id}/publish`, { data: {} })
    open.value = false
    await navigateTo(`/dataviews/${data.id}/settings?section=security`)
  } catch (error) {
    notifyError(error, t('database.quickDataView.error'))
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('database.quickDataView.title')"
    :description="t('database.quickDataView.description')"
  >
    <template #body>
      <div class="flex flex-col gap-5">
        <UFormField
          :label="t('database.quickDataView.name')"
          :description="t('database.quickDataView.nameHelp')"
          required
        >
          <UInput
            v-model="name"
            :maxlength="32"
            class="w-full"
          />
        </UFormField>
        <UFormField
          :label="t('database.quickDataView.roles')"
          :description="t('database.quickDataView.rolesHelp')"
        >
          <ObjectRolesList
            v-model="roleIds"
            :roles="roles"
          />
        </UFormField>
        <USwitch
          v-model="publish"
          :label="t('database.quickDataView.publish')"
          :description="t('database.quickDataView.publishHelp')"
        />
      </div>
    </template>
    <template #footer>
      <div class="flex w-full items-center justify-between gap-2">
        <UButton
          :label="t('database.quickDataView.more')"
          color="neutral"
          variant="ghost"
          @click="open = false; emit('more')"
        />
        <div class="flex gap-2">
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="ghost"
            @click="open = false"
          />
          <UButton
            :label="t('database.quickDataView.create')"
            :loading="creating"
            :disabled="!name.trim()"
            @click="create"
          />
        </div>
      </div>
    </template>
  </UModal>
</template>
