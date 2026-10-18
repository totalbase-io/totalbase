<script setup lang="ts">
// New role (RolesTree.vue) and, for a delegated manager, Details… (RoleDelegatedEditor.vue): RoleForm.vue in a
// modal. An administrator edits a role in its Settings tab instead (RoleAdminEditor.vue).
import type { Role } from '~/types/permission'
import type RoleForm from '~/components/RoleForm.vue'

const props = defineProps<{
  mode: 'create' | 'edit'
  role?: Role | null
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [Role] }>()
const { t } = useI18n()
const session = useSession()
const isAdmin = computed(() => session.access.value === 'ADMIN')

const form = ref<InstanceType<typeof RoleForm> | null>(null)
// The draft re-read on every open - the same modal serves whichever role's Details was clicked.
watch(open, (isOpen) => {
  if (isOpen) form.value?.seed()
})
function onSaved(role: Role) {
  open.value = false
  emit('saved', role)
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="mode === 'edit' ? t('users.roleForm.editTitle') : t('users.roleForm.newTitle')"
  >
    <template #body>
      <RoleForm
        ref="form"
        :mode="mode"
        :role="props.role"
        @saved="onSaved"
      />
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton
          :label="t('common.cancel')"
          color="neutral"
          variant="ghost"
          :disabled="form?.saving"
          @click="open = false"
        />
        <UButton
          :label="mode === 'edit' ? t('common.save') : t('common.create')"
          :loading="form?.saving"
          :disabled="form?.reserved && !isAdmin"
          @click="form?.submit()"
        />
      </div>
    </template>
  </UModal>
</template>
