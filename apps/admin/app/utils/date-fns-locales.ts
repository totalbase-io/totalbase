import type { Locale as DateFnsLocale } from 'date-fns'
import { enUS, es } from 'date-fns/locale'
import type { UiLanguage } from '@totalbase/shared'

/** date-fns' locale per UI language (Specification_Admin_UI.md §14) - month and day names in a formatted date. */
export const DATE_FNS_LOCALES: Record<UiLanguage, DateFnsLocale> = { en: enUS, es }
