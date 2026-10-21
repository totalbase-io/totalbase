<script setup lang="ts">
// Shared name/description/slug input (AGENTS.md section 10.1) - used by
// the Triggers wizard, Mailings templates, Integrations, and API
// Keys forms. `slug` auto-proposes live from `name` as the user types
// (client-side slugify(), see ~/utils/slugify.ts) and stops
// auto-updating the moment the user edits it by hand (Foundations.md §9.3's
// stability rule) - editing an existing row starts with slug already
// "touched" so a saved slug is never silently overwritten.
const props = withDefaults(defineProps<{
  slugTouched?: boolean
  /** Hides the Description field entirely - for a form where the row is never picked from a list by description (e.g. Proxies), so the field would just be dead weight. */
  hideDescription?: boolean
  /** Marks Description as required instead of the usual optional (e.g. DataViews - it's the label shown wherever a DataView is picked, so an empty one reads as broken there, not merely sparse). Validation itself stays the caller's job (computed step/form validity), this only changes the copy/asterisk. */
  descriptionRequired?: boolean
  /** The slug can't change by accident: an object already published is reached at it (links, references) - a lock, and Change slug behind a warning. */
  slugLocked?: boolean
}>(), {
  slugTouched: false,
  hideDescription: false,
  descriptionRequired: false,
  slugLocked: false
})
const emit = defineEmits<{ 'update:slugTouched': [boolean] }>()

const name = defineModel<string>('name', { required: true })
const description = defineModel<string | null>('description', { default: null })
const slug = defineModel<string>('slug', { required: true })
const { t } = useI18n()
/** Change slug: unlocked for this edit once its warning is accepted. */
const slugUnlocked = ref(false)
const slugReadonly = computed(() => props.slugLocked && !slugUnlocked.value)

// UTextarea's own model type doesn't accept null - description is
// nullable at the data layer (unset = no description) but the input
// itself only ever holds a string.
const descriptionText = computed({
  get: () => description.value ?? '',
  set: (value: string) => { description.value = value.trim() ? value : null }
})

const touched = ref(props.slugTouched)
watch(() => props.slugTouched, (value) => {
  touched.value = value
})

watch(name, (value) => {
  if (!touched.value) slug.value = slugify(value)
})

function onSlugInput() {
  touched.value = true
  emit('update:slugTouched', true)
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <UFormField
      :label="t('common.name')"
      required
      :description="t('shell.nameSlug.nameDescription')"
    >
      <UInput
        v-model="name"
        maxlength="32"
        autocomplete="off"
        class="w-full"
      />
    </UFormField>
    <UFormField
      v-if="!hideDescription"
      :label="t('common.description')"
      :required="descriptionRequired"
      :description="descriptionRequired
        ? t('shell.nameSlug.descriptionRequired')
        : t('shell.nameSlug.descriptionOptional')"
    >
      <UTextarea
        v-model="descriptionText"
        :rows="2"
        maxlength="128"
        class="w-full"
      />
    </UFormField>
    <UFormField
      :label="t('shell.nameSlug.slug')"
      required
      :description="slugReadonly ? t('shell.nameSlug.slugLocked') : t('shell.nameSlug.slugDescription')"
    >
      <!-- Locked: the Change slug button beside the input, as tall as it, a small gap between - not a word in its #trailing slot. -->
      <div class="flex w-full items-stretch gap-2">
        <UInput
          v-model="slug"
          :readonly="slugReadonly"
          :icon="slugReadonly ? 'i-lucide-lock' : undefined"
          class="flex-1 font-mono"
          @input="onSlugInput"
        />
        <UPopover v-if="slugReadonly">
          <UButton
            :label="t('shell.nameSlug.changeSlug')"
            color="neutral"
            variant="outline"
            class="h-full"
          />
          <template #content="{ close }">
            <div class="flex w-72 flex-col gap-3 p-3">
              <p class="text-sm">
                {{ t('shell.nameSlug.changeSlugWarning') }}
              </p>
              <div class="flex justify-end">
                <UButton
                  :label="t('shell.nameSlug.changeSlugConfirm')"
                  color="warning"
                  size="sm"
                  @click="slugUnlocked = true; close()"
                />
              </div>
            </div>
          </template>
        </UPopover>
      </div>
    </UFormField>
  </div>
</template>
