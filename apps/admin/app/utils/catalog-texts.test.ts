import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DASHBOARD_VARIABLE_TYPES, DATE_RANGE_PRESETS } from '~/types/dashboard'
import {
  AUTO_REFRESH_PRESETS, COLUMN_SYNC_META, DATAVIEW_FEATURES, DATAVIEW_TYPE_META, DENSITY_META, DESIGNER_VIEWS, EDIT_PRESENTATION_META, EDIT_SIDE_META,
  EDIT_SIZE_META, FORM_VIEW_MODE_META, MASTER_DETAIL_OPEN_WITH_META, PAGE_CONTENT_ALIGN_META, PAGE_CONTENT_WIDTH_META, dataviewMetaKey, featureDescriptionKey,
  featureLabelKey, type DataViewType
} from '~/types/dataview'
import { FORMULA_ERROR_CODES } from '~/utils/formula-engine'
import { knownAuthProviders } from '~/utils/known-auth-providers'
import { PUBLISH_STATUS_META } from '~/utils/publish-status'

/**
 * The admin's own lists keep their English beside a key that translates them (Admin_UI.md §14) - a DataView's
 * types and features, a dashboard's date ranges, the known sign-in providers, a formula's errors. A key missing shows the English in
 * every other language, silently: every entry here has its key in English (and so, by locales.test.ts, in every
 * language). The packages' catalogs are scripts/i18n-coverage.test.ts's.
 */
const DIR = join(__dirname, '../../i18n/locales/en')
type Messages = { [key: string]: string | Messages }
const english: Messages = Object.assign({}, ...readdirSync(DIR).map(file => JSON.parse(readFileSync(join(DIR, file), 'utf8')) as Messages))
const exists = (key: string) => key.split('.').reduce<string | Messages | undefined>((node, part) => (typeof node === 'object' ? node[part] : undefined), english) !== undefined

describe('the admin\'s own lists', () => {
  it('every entry has its key', () => {
    const missing: string[] = []
    const need = (key: string) => {
      if (!exists(key)) missing.push(key)
    }
    const meta = (catalog: string, record: Record<string, { label: string, description?: string }>) => {
      for (const [key, entry] of Object.entries(record)) {
        need(dataviewMetaKey(catalog, key, 'label'))
        if (entry.description) need(dataviewMetaKey(catalog, key, 'description'))
      }
    }
    meta('types', DATAVIEW_TYPE_META)
    meta('formViewModes', FORM_VIEW_MODE_META)
    meta('openWith', MASTER_DETAIL_OPEN_WITH_META)
    meta('editPresentations', EDIT_PRESENTATION_META)
    meta('editSizes', EDIT_SIZE_META)
    meta('editSides', EDIT_SIDE_META)
    meta('pageContentAligns', PAGE_CONTENT_ALIGN_META)
    meta('pageContentWidths', PAGE_CONTENT_WIDTH_META)
    meta('columnSync', COLUMN_SYNC_META)
    meta('densities', DENSITY_META)
    for (const [type, features] of Object.entries(DATAVIEW_FEATURES)) {
      for (const feature of features ?? []) {
        need(featureLabelKey(feature))
        need(featureDescriptionKey(type as DataViewType, feature))
      }
    }
    // A duration (10s, 1m) reads the same in every language; Off and Custom… don't.
    for (const preset of AUTO_REFRESH_PRESETS) if (/[a-z]{2,}/i.test(preset.label.replace(/^\d+/, ''))) need(`dataviews.meta.autoRefresh.${preset.value}`)
    for (const view of DESIGNER_VIEWS) need(`dataviews.meta.designerViews.${view.value}`)
    for (const preset of DATE_RANGE_PRESETS) need(`dashboards.variables.presets.${preset.value}`)
    for (const type of DASHBOARD_VARIABLE_TYPES) {
      need(`dashboards.variables.types.${type.value}.label`)
      need(`dashboards.variables.types.${type.value}.description`)
    }
    // A provider is named by its brand (Google, GitHub), the same in every language - its fields aren't.
    for (const provider of knownAuthProviders) {
      for (const field of provider.fields ?? []) {
        need(`settings.authProviders.known.${provider.id}.fields.${field.key}.label`)
        if (field.description) need(`settings.authProviders.known.${provider.id}.fields.${field.key}.description`)
      }
    }
    for (const code of FORMULA_ERROR_CODES) need(`dataviews.formulaErrors.${code}`)
    for (const status of Object.values(PUBLISH_STATUS_META)) {
      need(status.labelKey)
      need(status.shortKey)
    }
    expect(missing).toEqual([])
  })
})
