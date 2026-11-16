/**
 * The toast after Publish (Foundations.md §13.6), the same in every editor: the server answers 201 with the version
 * it created, or 200 with the live one when the draft already equaled it - then nothing was published, and saying
 * "published" would hide that the edits it expected aren't in the draft.
 */
export function usePublishToast() {
  const toast = useToast()
  const { t } = useI18n()
  return (result: { status?: number, data: { version: number } }, publishedTitle: string) => {
    if (result.status === 200) {
      toast.add({ title: t('shell.versions.nothingToPublish'), description: t('shell.versions.alreadyLive', { version: result.data.version }), color: 'neutral' })
    } else {
      toast.add({ title: publishedTitle, color: 'success' })
    }
    return result.status !== 200
  }
}
