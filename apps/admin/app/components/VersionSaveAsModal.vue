<script setup lang="ts">
/**
 * "Save as…" from a version's read-only preview (Foundations.md §13.4):
 * asks the new object's name/slug, then the host calls
 * its pillar's `…/versions/:version/duplicate`. The copy starts as an
 * unpublished draft with no access grants.
 */
const props = defineProps<{
  /** What's being duplicated, e.g. "Sales Overview v3" - shown in the description. */
  sourceLabel: string
  loading?: boolean
}>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ submit: [{ name: string, slug: string }] }>()
const { t } = useI18n()

const name = ref('')
const slug = ref('')
const slugTouched = ref(false)
const description = ref<string | null>(null)

watch(open, (isOpen) => {
  if (!isOpen) return
  name.value = ''
  slug.value = ''
  slugTouched.value = false
})

const valid = computed(() => name.value.trim().length > 0 && slug.value.trim().length > 0)
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('shell.versions.saveAsTitle')"
    :description="t('shell.versions.saveAsDescription', { source: props.sourceLabel })"
  >
    <template #body>
      <NameSlugFields
        v-model:name="name"
        v-model:description="description"
        v-model:slug="slug"
        v-model:slug-touched="slugTouched"
        hide-description
      />
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          :label="t('common.cancel')"
          color="neutral"
          variant="ghost"
          :disabled="loading"
          @click="open = false"
        />
        <UButton
          :label="t('shell.versions.createCopy')"
          :loading="loading"
          :disabled="!valid"
          @click="emit('submit', { name: name.trim(), slug: slug.trim() })"
        />
      </div>
    </template>
  </UModal>
</template>
