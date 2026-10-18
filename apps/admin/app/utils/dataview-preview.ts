import type { InjectionKey } from 'vue'

/**
 * Provided by DataViewVersionPreview.vue (a version's or the draft's
 * read-only preview): anything opened from inside it - a Detail's record
 * in another DataView - stays read-only too, and a
 * PAGE-mode DataView opens as a modal there instead of leaving the preview.
 */
export const DATAVIEW_READONLY_PREVIEW_KEY: InjectionKey<boolean> = Symbol('dataview-readonly-preview')
