import { describe, expect, it } from 'vitest'
import { createKeyburstReader, fromZxingFormat, parseScannerFormats, toZxingFormats } from './code-scanner'

/** A reader typing `text` then Enter, `gap` ms apart, from `start`. */
function type(reader: ReturnType<typeof createKeyburstReader>, text: string, gap: number, start = 1000) {
  let t = start
  for (const key of text) {
    reader.feed({ key, timeStamp: t, ctrlKey: false, metaKey: false, altKey: false })
    t += gap
  }
  return reader.feed({ key: 'Enter', timeStamp: t, ctrlKey: false, metaKey: false, altKey: false })
}

describe('createKeyburstReader', () => {
  it('reads a USB reader\'s burst - a DNI\'s PDF417 typed in a few ms per key', () => {
    const dni = '00123456789@PEREZ@ANA@F@30111222@A@01/02/1990@15/03/2015'
    expect(type(createKeyburstReader(), dni, 4)).toBe(dni)
  })

  it('ignores a person typing, and a code too short', () => {
    expect(type(createKeyburstReader(), '30111222', 140)).toBeNull()
    expect(type(createKeyburstReader(), 'ab', 3)).toBeNull()
  })

  it('starts over after a pause: only the burst after it is read', () => {
    const reader = createKeyburstReader()
    reader.feed({ key: 'x', timeStamp: 0, ctrlKey: false, metaKey: false, altKey: false })
    expect(type(reader, 'ABC123', 5, 5000)).toBe('ABC123')
  })

  it('leaves shortcuts alone', () => {
    const reader = createKeyburstReader()
    expect(reader.feed({ key: 'c', timeStamp: 1, ctrlKey: true, metaKey: false, altKey: false })).toBeNull()
  })
})

describe('scanner formats', () => {
  it('reads the prop: known names, empty for all', () => {
    expect(parseScannerFormats('pdf417, QR_CODE, nope')).toEqual(['pdf417', 'qr_code'])
    expect(parseScannerFormats('')).toContain('pdf417')
  })

  it('maps BarcodeDetector names to zxing-cpp and back', () => {
    expect(toZxingFormats(['pdf417', 'qr_code', 'ean_13'])).toEqual(['PDF417', 'QRCode', 'EAN13'])
    expect(fromZxingFormat('PDF417')).toBe('pdf417')
    expect(fromZxingFormat('EAN-13')).toBe('ean_13')
    expect(fromZxingFormat('QRCodeModel2')).toBe('qr_code')
    expect(fromZxingFormat('MaxiCode')).toBeNull()
  })
})
