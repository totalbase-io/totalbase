<script setup lang="ts">
/**
 * Saving what's on screen as a view (DataViews.md §5.9) - the views menu's and the Filter panel's:
 * a name and Save. A saved view never changes; saving under the name of one of one's own views asks first, then
 * replaces it. Props in, events out: the grid owns the save.
 */
import type { SavedView } from '~/types/dataview'

const props = defineProps<{
  /** The viewer's own views - a name already one of theirs asks to replace it. */
  views: SavedView[]
  /** The name proposed when it opens. */
  defaultName?: string
  saving?: boolean
}>()
const emit = defineEmits<{ save: [name: string], replace: [id: string], cancel: [] }>()

const { t } = useI18n()
/** dataviews_states.name's CHECK. */
const NAME_MAX = 32

const name = ref(props.defaultName ?? '')
/** The own view a save would replace, once asked. */
const replacing = ref<SavedView | null>(null)
watch(name, () => (replacing.value = null))

function submit() {
  const value = name.value.trim()
  if (!value || props.saving) return
  const existing = props.views.find(v => v.isOwner && v.name.trim().toLowerCase() === value.toLowerCase())
  if (!existing) {
    emit('save', value)
    return
  }
  if (replacing.value?.id === existing.id) emit('replace', existing.id)
  else replacing.value = existing
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <UFormField
      :label="t('common.name')"
      :description="t('dataviews.savedViews.nameDescription')"
    >
      <UInput
        v-model="name"
        :maxlength="NAME_MAX"
        class="w-full"
        autofocus
        @keydown.enter.prevent="submit"
      />
    </UFormField>
    <p
      v-if="replacing"
      class="text-sm text-warning"
    >
      {{ t('dataviews.savedViews.replaceQuestion', { name: replacing.name }) }}
    </p>
    <div class="flex justify-end gap-2">
      <UButton
        :label="t('common.cancel')"
        color="neutral"
        variant="outline"
        @click="replacing ? (replacing = null) : emit('cancel')"
      />
      <UButton
        :label="replacing ? t('dataviews.savedViews.replace') : t('common.save')"
        :color="replacing ? 'warning' : 'primary'"
        :loading="saving"
        :disabled="!name.trim()"
        @click="submit"
      />
    </div>
  </div>
</template>
