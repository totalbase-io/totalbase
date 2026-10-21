<script setup lang="ts">
/**
 * Picks one role for a bulk membership action (Security.md
 * §9.4) - "Add to role", "Move to role"... Roles listed as everywhere: name
 * in bold, description beneath (AGENTS.md section 10.1).
 */
import type { Role } from '~/types/permission'
import { isWorkflowsRole } from '~/types/security'

const props = defineProps<{
  title: string
  description: string
  confirmLabel: string
  /** Roles not to offer (the one the users are moved out of). */
  excludeRoleIds?: string[]
  loading?: boolean
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ pick: [roleId: string] }>()

const rolesApi = useRolesApi()
const { t } = useI18n()
const roles = ref<Role[]>([])
const roleId = ref<string | undefined>(undefined)
watch(open, async (isOpen) => {
  if (!isOpen) return
  roleId.value = undefined
  roles.value = await rolesApi.list()
}, { immediate: true })
const items = computed(() => roles.value
  .filter(r => !props.excludeRoleIds?.includes(r.id) && !isWorkflowsRole(r))
  .map(r => ({ label: r.name, description: r.description ?? undefined, value: r.id })))
</script>

<template>
  <UModal
    v-model:open="open"
    :title="title"
    :description="description"
  >
    <template #body>
      <UFormField :label="t('common.role')">
        <USelectMenu
          v-model="roleId"
          :items="items"
          value-key="value"
          :aria-label="t('common.role')"
          class="w-full"
        />
      </UFormField>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          :label="t('common.cancel')"
          color="neutral"
          variant="ghost"
          @click="open = false"
        />
        <UButton
          :label="confirmLabel"
          :loading="loading"
          :disabled="!roleId"
          @click="roleId && emit('pick', roleId)"
        />
      </div>
    </template>
  </UModal>
</template>
