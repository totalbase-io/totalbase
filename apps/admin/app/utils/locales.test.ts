import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { baseCompile } from '@intlify/message-compiler'
import { describe, expect, it } from 'vitest'
import { DEFAULT_UI_LANGUAGE, UI_LANGUAGES } from '@totalbase/shared'

/**
 * The locale files (Admin_UI.md §14): every language has every
 * area file and every key English has - English is the source - with no
 * empty text, and each area keeps to its own top-level keys.
 */
const DIR = join(__dirname, '../../i18n/locales')
type Messages = { [key: string]: string | Messages }
const read = (language: string, file: string) => JSON.parse(readFileSync(join(DIR, language, file), 'utf8')) as Messages
function keys(messages: Messages, prefix = ''): string[] {
  return Object.entries(messages).flatMap(([key, value]) => (typeof value === 'string' ? [`${prefix}${key}`] : keys(value, `${prefix}${key}.`)))
}
function empty(messages: Messages, prefix = ''): string[] {
  return Object.entries(messages).flatMap(([key, value]) => (typeof value === 'string' ? (value.trim() ? [] : [`${prefix}${key}`]) : empty(value, `${prefix}${key}.`)))
}

describe('locale files', () => {
  const areas = readdirSync(join(DIR, DEFAULT_UI_LANGUAGE)).filter(f => f.endsWith('.json'))

  it.each(UI_LANGUAGES.map(l => l.code))('%s has every area and every English key, none empty', (language) => {
    for (const area of areas) {
      const english = keys(read(DEFAULT_UI_LANGUAGE, area)).sort()
      const translated = read(language, area)
      expect(keys(translated).sort(), `${language}/${area}`).toEqual(english)
      expect(empty(translated), `${language}/${area}`).toEqual([])
    }
  })

  // One message that doesn't compile fails its whole area's file at load - every text of the language then shows its key.
  it.each(UI_LANGUAGES.map(l => l.code))('%s: every message compiles', (language) => {
    const broken: string[] = []
    const walk = (messages: Messages, prefix: string, area: string) => {
      for (const [key, value] of Object.entries(messages)) {
        if (typeof value !== 'string') {
          walk(value, `${prefix}${key}.`, area)
          continue
        }
        baseCompile(value, { onError: error => broken.push(`${area}: ${prefix}${key} - ${error.message}`) })
      }
    }
    for (const area of areas) walk(read(language, area), '', area)
    expect(broken).toEqual([])
  })

  it('no two areas share a top-level key', () => {
    const owners = new Map<string, string>()
    for (const area of areas) {
      for (const key of Object.keys(read(DEFAULT_UI_LANGUAGE, area))) {
        expect(owners.get(key), `"${key}" in ${area} and ${owners.get(key)}`).toBeUndefined()
        owners.set(key, area)
      }
    }
  })
})
