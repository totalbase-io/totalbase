<script setup lang="ts">
/**
 * Restore… on a completed backup (Administration.md §12.5): a wizard that
 * runs nothing - it hands the administrator the commands that restore the
 * backup into a new, empty database of their Docker Compose setup and
 * switch the instance to it, with the way back. The restore replaces the
 * instance, so it runs with the server stopped, by the image's own
 * `totalbase restore`. Built by utils/backup-restore-commands.ts.
 */
import type { Backup } from '~/types/backup'
import type { WizardStep } from '~/components/WizardModal.vue'
import { isComposeService, isRestoreIdentifier, proposedDatabase, restoreCommands, type RestoreBackup } from '~/utils/backup-restore-commands'

const props = defineProps<{
  backup: Backup | null
  /** backups.local_path - where a local backup's archive is, inside the container. */
  localPath: string
}>()
const emit = defineEmits<{ download: [backup: Backup] }>()
const open = defineModel<boolean>('open', { default: false })
const { t } = useI18n()
const toast = useToast()
const ui = useUiLocale()

const restoreBackup = computed<RestoreBackup | null>(() => {
  const backup = props.backup
  if (!backup?.manifest) return null
  return { name: backup.name, destination: backup.destination, database: backup.manifest.database, files: backup.manifest.files, filesPath: backup.manifest.filesPath, createdAt: backup.createdAt }
})

const form = reactive({ database: '', user: 'totalbase', postgresInCompose: true, appService: 'totalbase', dbService: 'postgres' })
// A fresh proposal each time it opens.
watch(open, (isOpen) => {
  if (!isOpen || !restoreBackup.value) return
  Object.assign(form, { database: proposedDatabase(restoreBackup.value), user: 'totalbase', postgresInCompose: true, appService: 'totalbase', dbService: 'postgres' })
})

const optionsValid = computed(() => isRestoreIdentifier(form.database) && isRestoreIdentifier(form.user) && isComposeService(form.appService)
  && (!form.postgresInCompose || isComposeService(form.dbService)) && form.database !== restoreBackup.value?.database)
const steps = computed<WizardStep[]>(() => [
  { key: 'before', title: t('settings.backups.restore.before'), description: t('settings.backups.restore.beforeHelp') },
  { key: 'options', title: t('settings.backups.restore.options'), description: t('settings.backups.restore.optionsHelp'), valid: optionsValid.value },
  { key: 'commands', title: t('settings.backups.restore.commands'), description: t('settings.backups.restore.commandsHelp') }
])
const commands = computed(() => (restoreBackup.value && optionsValid.value ? restoreCommands(restoreBackup.value, { ...form, localPath: props.localPath }) : []))
const runSteps = computed(() => commands.value.filter(c => c.step !== 'rollback'))
const rollback = computed(() => commands.value.find(c => c.step === 'rollback'))
const locationItems = computed(() => [
  { label: t('settings.backups.restore.postgresInCompose'), description: t('settings.backups.restore.postgresInComposeHelp'), value: true },
  { label: t('settings.backups.restore.postgresElsewhere'), description: t('settings.backups.restore.postgresElsewhereHelp'), value: false }
])
const when = computed(() => (props.backup ? new Intl.DateTimeFormat(ui.intlLocale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(props.backup.createdAt)) : ''))

async function copy(text: string) {
  await navigator.clipboard.writeText(text)
  toast.add({ title: t('settings.backups.restore.copied'), color: 'success' })
}
</script>

<template>
  <WizardModal
    v-model:open="open"
    :title="t('settings.backups.restore.title')"
    :description="backup ? t('settings.backups.restore.description', { when, name: backup.name }) : undefined"
    :steps="steps"
    :submit-label="t('settings.backups.restore.done')"
    width="max-w-4xl"
    @submit="open = false"
  >
    <template #before>
      <div class="flex flex-col gap-3 text-sm">
        <p>{{ t('settings.backups.restore.what') }}</p>
        <ul class="list-disc space-y-1 pl-5 text-muted">
          <li>{{ t('settings.backups.restore.whatDatabase', { database: restoreBackup?.database ?? '' }) }}</li>
          <li v-if="restoreBackup?.files">
            {{ t('settings.backups.restore.whatFiles') }}
          </li>
          <li>{{ t('settings.backups.restore.whatStopped') }}</li>
          <li>{{ t('settings.backups.restore.whatSince', { when }) }}</li>
        </ul>
        <UAlert
          color="warning"
          variant="subtle"
          icon="i-lucide-key-round"
          :title="t('settings.backups.restore.masterKey')"
          :description="t('settings.backups.restore.masterKeyHelp')"
        />
      </div>
    </template>

    <template #options>
      <div class="flex flex-col gap-4">
        <UFormField
          :label="t('settings.backups.restore.database')"
          :description="t('settings.backups.restore.databaseHelp')"
          :error="form.database && !isRestoreIdentifier(form.database) ? t('settings.backups.restore.identifierError') : form.database === restoreBackup?.database ? t('settings.backups.restore.sameDatabase') : undefined"
          required
        >
          <UInput
            v-model="form.database"
            class="w-full font-mono"
          />
        </UFormField>
        <UFormField
          :label="t('settings.backups.restore.user')"
          :description="t('settings.backups.restore.userHelp')"
          :error="form.user && !isRestoreIdentifier(form.user) ? t('settings.backups.restore.identifierError') : undefined"
          required
        >
          <UInput
            v-model="form.user"
            class="w-full font-mono"
          />
        </UFormField>
        <UFormField :label="t('settings.backups.restore.postgres')">
          <URadioGroup
            v-model="form.postgresInCompose"
            :items="locationItems"
          />
        </UFormField>
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField
            :label="t('settings.backups.restore.appService')"
            :error="!isComposeService(form.appService) ? t('settings.backups.restore.serviceError') : undefined"
          >
            <UInput
              v-model="form.appService"
              class="w-full font-mono"
            />
          </UFormField>
          <UFormField
            v-if="form.postgresInCompose"
            :label="t('settings.backups.restore.dbService')"
            :error="!isComposeService(form.dbService) ? t('settings.backups.restore.serviceError') : undefined"
          >
            <UInput
              v-model="form.dbService"
              class="w-full font-mono"
            />
          </UFormField>
        </div>
      </div>
    </template>

    <template #commands>
      <ol class="flex flex-col gap-4">
        <li
          v-for="(item, index) in runSteps"
          :key="item.step"
          class="flex flex-col gap-1.5"
        >
          <p class="text-sm">
            <span class="font-semibold">{{ index + 1 }}.</span>
            {{ t(`settings.backups.restore.steps.${item.step}`, { name: backup?.name ?? '' }) }}
          </p>
          <UButton
            v-if="item.step === 'download' && backup"
            icon="i-lucide-download"
            :label="t('common.download')"
            color="neutral"
            variant="outline"
            class="self-start"
            @click="emit('download', backup)"
          />
          <div
            v-else
            class="relative"
          >
            <pre class="overflow-x-auto rounded-md border border-default bg-elevated p-3 pr-10 font-mono text-xs">{{ item.command }}</pre>
            <UButton
              icon="i-lucide-copy"
              :aria-label="t('settings.backups.restore.copy')"
              color="neutral"
              variant="ghost"
              size="xs"
              class="absolute top-2 right-2"
              @click="copy(item.command)"
            />
          </div>
        </li>
      </ol>
      <div
        v-if="rollback"
        class="mt-6 flex flex-col gap-1.5"
      >
        <p class="text-sm font-semibold">
          {{ t('settings.backups.restore.rollbackTitle') }}
        </p>
        <p class="text-sm text-muted">
          {{ t('settings.backups.restore.steps.rollback') }}
        </p>
        <div class="relative">
          <pre class="overflow-x-auto rounded-md border border-default bg-elevated p-3 pr-10 font-mono text-xs">{{ rollback.command }}</pre>
          <UButton
            icon="i-lucide-copy"
            :aria-label="t('settings.backups.restore.copy')"
            color="neutral"
            variant="ghost"
            size="xs"
            class="absolute top-2 right-2"
            @click="copy(rollback.command)"
          />
        </div>
      </div>
    </template>
  </WizardModal>
</template>
