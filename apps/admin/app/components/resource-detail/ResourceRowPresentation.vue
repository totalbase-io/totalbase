<script setup lang="ts">
/**
 * A table's row presentation (Specification_DataViews.md §15.5): how one of
 * its rows shows wherever a foreign key points at it - a column or a
 * template - inherited by every foreign-key column of every DataView that
 * sets none of its own. Two fields, so a popover on the Columns header.
 */
import { templateColumns, type RowPresentation } from '@totalbase/tb-catalog'
import type { Resource } from '~/types/resource'

const props = defineProps<{ resource: Resource, columns: string[], disabled?: boolean }>()
const emit = defineEmits<{ saved: [presentation: RowPresentation] }>()

const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()

const open = ref(false)
const saved = ref<RowPresentation>({ ...props.resource.rowPresentation })
const displayField = ref('')
const displayTemplate = ref('')
watch(open, (isOpen) => {
  if (!isOpen) return
  displayField.value = saved.value.displayField ?? ''
  displayTemplate.value = saved.value.displayTemplate ?? ''
})

const fieldItems = computed(() => [{ label: t('database.resourceRowPresentation.default'), value: 'default' }, ...props.columns.map(c => ({ label: c, value: c }))])
const templateError = computed(() => {
  const template = displayTemplate.value.trim()
  if (!template) return null
  const named = templateColumns(template)
  if (named.length === 0) return t('database.resourceRowPresentation.nameAColumn', { example: '{{column}}' })
  const unknown = named.filter(c => !props.columns.includes(c))
  return unknown.length ? t('database.resourceRowPresentation.unknownColumns', { table: props.resource.name, columns: unknown.join(', ') }) : null
})
/** What the Columns header says it's set to. */
const summary = computed(() => saved.value.displayTemplate ?? saved.value.displayField ?? null)

const saving = ref(false)
async function save() {
  if (templateError.value) return
  saving.value = true
  try {
    const body: RowPresentation = {
      ...(displayField.value ? { displayField: displayField.value } : {}),
      ...(displayTemplate.value.trim() ? { displayTemplate: displayTemplate.value.trim() } : {})
    }
    saved.value = (await api.put<RowPresentation>(`/resources/${props.resource.id}/row-presentation`, { data: body })).data
    open.value = false
    toast.add({ title: t('database.resourceRowPresentation.saved'), color: 'success' })
    emit('saved', saved.value)
  } catch (err) {
    notifyError(err, t('database.resourceRowPresentation.saveError'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UPopover v-model:open="open">
    <UButton
      icon="i-lucide-rows-3"
      size="sm"
      color="neutral"
      variant="outline"
      :disabled="disabled"
      :label="t('database.resourceRowPresentation.rowDisplay')"
      :aria-label="summary ? t('database.resourceRowPresentation.rowDisplayAria', { summary }) : t('database.resourceRowPresentation.rowDisplay')"
    />
    <template #content>
      <div class="flex w-80 flex-col gap-4 p-3">
        <p class="text-sm text-muted">
          <i18n-t
            v-if="summary"
            keypath="database.resourceRowPresentation.now"
          >
            <template #value>
              <span class="font-mono">{{ summary }}</span>
            </template>
          </i18n-t>
          {{ t('database.resourceRowPresentation.intro', { name: resource.name }) }}
        </p>
        <UFormField
          :label="t('database.resourceRowPresentation.show')"
          :description="t('database.resourceRowPresentation.showDescription')"
        >
          <USelect
            :model-value="displayField || 'default'"
            :items="fieldItems"
            class="w-full"
            @update:model-value="(v: string) => displayField = v === 'default' ? '' : v"
          />
        </UFormField>
        <UFormField
          :label="t('database.resourceRowPresentation.template')"
          :description="t('database.resourceRowPresentation.templateDescription', { example: '{{name}} ({{code}})', columns: columns.join(', ') })"
          :error="templateError ?? undefined"
        >
          <UInput
            v-model="displayTemplate"
            class="w-full font-mono"
            :aria-label="t('database.resourceRowPresentation.templateAria')"
          />
        </UFormField>
        <div class="flex justify-end gap-2">
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="ghost"
            @click="open = false"
          />
          <UButton
            :label="t('common.save')"
            :loading="saving"
            :disabled="!!templateError"
            @click="save"
          />
        </div>
      </div>
    </template>
  </UPopover>
</template>
