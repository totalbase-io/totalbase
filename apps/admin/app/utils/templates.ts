// Shared shape/labels for the Templates screen (TemplatesTree.vue,
// NewTemplateModal.vue, pages/templates/[id].vue). `kind` stays the
// stored MAILING/PDF value; only its display label differs - the group
// reads "Emails" since a MAILING template today only ever feeds an email.
export type TemplateKind = 'MAILING' | 'PDF'

export interface TemplateSummary {
  id: string
  name: string
  description: string | null
  slug: string
  kind: TemplateKind
  content: unknown
  defaultCc: string[] | null
  defaultBcc: string[] | null
  defaultReplyTo: string | null
  createdAt: string
  updatedAt: string
}

export const TEMPLATE_KINDS: TemplateKind[] = ['MAILING', 'PDF']

/**
 * A kind's texts are i18n keys - `content.templates.kinds.<KIND>.group`,
 * `.label` and `.description` (the description takes `{example}`, a
 * `{{variable}}` placeholder) - translated where they're shown.
 */
export const TEMPLATE_KIND_META: Record<TemplateKind, { icon: string }> = {
  MAILING: { icon: 'i-lucide-mail' },
  PDF: { icon: 'i-lucide-file-text' }
}

// pdfme's own blank starting point (PdfTemplateDesigner.vue's
// BLANK_TEMPLATE) - the DB's templates_content_is_object check requires
// an actual object, so a PDF template can't be created with null content.
export const BLANK_PDF_CONTENT = { basePdf: { width: 210, height: 297, padding: [10, 10, 10, 10] }, schemas: [[]] }
