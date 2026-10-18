<script setup lang="ts">
// Dashboard creation: a single small modal, not the multi-step wizard
// (AGENTS.md §25 "Multi-step wizards" - reserved for flows that can't
// fit one screen without overwhelming it). Unlike a DataView, a
// Dashboard has no type/source choice at creation time - just identity
// (name/slug/description/icon/color); widgets are added one at a time on
// the canvas afterward, each with its own independent resource/columns.
// Same shape as templates.vue's own "Step 1: name/description/slug"
// modal.
import type { Dashboard } from '~/types/dashboard'
import type { RoleColor } from '~/types/permission'
import { useApiErrorMessage } from '~/utils/api-error-message'

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ created: [Dashboard] }>()

const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const errorMessage = useApiErrorMessage()

const name = ref('')
const description = ref<string | null>(null)
const slug = ref('')
const slugTouched = ref(false)
const icon = ref<string | undefined>(undefined)
const color = ref<RoleColor | undefined>(undefined)
const scope = ref<'LISTED' | 'EMBEDDED_ONLY'>('LISTED')
const creating = ref(false)

function reset() {
  name.value = ''
  description.value = null
  slug.value = ''
  slugTouched.value = false
  icon.value = undefined
  color.value = undefined
  scope.value = 'LISTED'
}

watch(open, (value) => {
  if (value) reset()
})

async function create() {
  if (!name.value.trim() || !slug.value.trim()) {
    toast.add({ title: t('dashboards.createModal.nameSlugRequired'), color: 'error' })
    return
  }
  creating.value = true
  try {
    const { data } = await api.post<Dashboard>('/dashboards', {
      data: {
        name: name.value,
        slug: slug.value,
        description: description.value,
        icon: icon.value ?? null,
        color: color.value ?? null,
        scope: scope.value
      }
    })
    open.value = false
    emit('created', data)
  } catch (error) {
    toast.add({
      title: errorMessage(error, t('dashboards.createModal.createFailed')),
      color: 'error'
    })
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('dashboards.createModal.title')"
    :description="t('dashboards.createModal.description')"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <NameSlugFields
          v-model:name="name"
          v-model:description="description"
          v-model:slug="slug"
          v-model:slug-touched="slugTouched"
        />
        <div class="flex gap-3">
          <IconPickerField
            v-model="icon"
            :label="t('common.icon')"
            options="lucide"
          />
          <ColorPickerField
            v-model="color"
            :label="t('common.color')"
            allow-none
          />
        </div>
        <ShowInAppMenuField
          v-model="scope"
          kind="Dashboard"
        />
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
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
          @click="create"
        />
      </div>
    </template>
  </UModal>
</template>
