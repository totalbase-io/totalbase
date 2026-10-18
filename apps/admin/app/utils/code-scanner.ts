/**
 * What the Scanner widget (TScanner, Specification_DataViews.md §9.9) reads
 * codes with - kept apart from the component so the timing and the format
 * mapping are tested on their own:
 *
 * - a USB reader in keyboard mode types the code and Enter, much faster than
 *   a person: `createKeyburstReader` tells that burst from typing;
 * - a camera frame is read by the browser's BarcodeDetector where it knows
 *   every requested format (Chrome on Android, desktop Chrome on macOS), else
 *   by zxing-wasm, loaded only then - its .wasm served by the admin itself,
 *   never fetched from a CDN.
 */
import { SCANNER_FORMATS, type ScannerFormat } from '@totalbase/tb-catalog'
import { playTones, vibrate } from '~/utils/device-feedback'

/** A code read: its text, its format (null from a keyboard reader - it only types) and where it came from. */
export interface ScanResult {
  value: string
  format: ScannerFormat | null
  source: 'camera' | 'keyboard'
}

/** The `formats` prop - comma-separated, empty for all - as the formats it names; unknown names are ignored. */
export function parseScannerFormats(text: string | null | undefined): ScannerFormat[] {
  const wanted = (text ?? '').split(',').map(f => f.trim().toLowerCase()).filter(Boolean)
  const known = wanted.filter((f): f is ScannerFormat => (SCANNER_FORMATS as readonly string[]).includes(f))
  return known.length > 0 ? known : [...SCANNER_FORMATS]
}

/** BarcodeDetector's names → zxing-cpp's. */
const ZXING_FORMATS: Record<ScannerFormat, string> = {
  qr_code: 'QRCode',
  pdf417: 'PDF417',
  code_128: 'Code128',
  code_39: 'Code39',
  code_93: 'Code93',
  ean_13: 'EAN13',
  ean_8: 'EAN8',
  upc_a: 'UPCA',
  upc_e: 'UPCE',
  itf: 'ITF',
  codabar: 'Codabar',
  data_matrix: 'DataMatrix',
  aztec: 'Aztec'
}

/** A zxing-cpp format name (`QRCode`, `PDF417`, `EAN-13`...) as BarcodeDetector's, or null for one we don't list. */
export function fromZxingFormat(format: string): ScannerFormat | null {
  const plain = format.replace(/[^A-Za-z0-9]/g, '').toLowerCase()
  const found = (Object.entries(ZXING_FORMATS) as [ScannerFormat, string][]).find(([, z]) => z.toLowerCase() === plain)
  if (found) return found[0]
  if (plain.startsWith('qrcode')) return 'qr_code'
  if (plain.includes('pdf417')) return 'pdf417'
  return null
}

export function toZxingFormats(formats: readonly ScannerFormat[]): string[] {
  return formats.map(f => ZXING_FORMATS[f])
}

// --- A USB reader in keyboard mode -----------------------------------------

export interface KeyburstOptions {
  /** Longest pause between two keys of one burst - a reader types every few ms, a person every 100+. */
  maxGapMs?: number
  /** Shortest code worth reading. */
  minLength?: number
}

/**
 * Feeds keydown events; returns the code when a fast burst ends in Enter (or
 * Tab, which some readers send), null otherwise. A pause longer than
 * `maxGapMs` starts over, so a person typing never reads as a scan.
 */
export function createKeyburstReader(options: KeyburstOptions = {}) {
  const maxGap = options.maxGapMs ?? 50
  const minLength = options.minLength ?? 4
  let buffer = ''
  let last = -Infinity
  return {
    /** The code a burst ended with, or null - `event.key` and `event.timeStamp` are all it reads. */
    feed(event: Pick<KeyboardEvent, 'key' | 'timeStamp' | 'ctrlKey' | 'metaKey' | 'altKey'>): string | null {
      if (event.ctrlKey || event.metaKey || event.altKey) return null
      const gap = event.timeStamp - last
      if (event.key === 'Enter' || event.key === 'Tab') {
        const code = gap <= maxGap && buffer.length >= minLength ? buffer : null
        buffer = ''
        last = -Infinity
        return code
      }
      if (event.key.length !== 1) return null
      buffer = gap <= maxGap ? buffer + event.key : event.key
      last = event.timeStamp
      return null
    },
    reset() {
      buffer = ''
      last = -Infinity
    }
  }
}

// --- A camera frame ----------------------------------------------------------

type Frame = HTMLVideoElement | HTMLCanvasElement | ImageBitmap | Blob

export interface FrameReader {
  /** The first code in the frame, or null. */
  read(frame: Frame): Promise<{ value: string, format: ScannerFormat | null } | null>
  native: boolean
}

interface NativeDetector {
  detect(source: unknown): Promise<{ rawValue: string, format: string }[]>
}
interface NativeDetectorClass {
  new (options: { formats: string[] }): NativeDetector
  getSupportedFormats(): Promise<string[]>
}

let zxingReady: Promise<typeof import('zxing-wasm/reader')> | null = null
/** zxing-wasm's reader, its .wasm from the admin's own assets (Vite's ?url) - loaded once, on the first frame that needs it. */
function zxing() {
  zxingReady ??= Promise.all([import('zxing-wasm/reader'), import('zxing-wasm/reader/zxing_reader.wasm?url')]).then(([module, wasm]) => {
    module.prepareZXingModule({ overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasm.default : prefix + path) }, fireImmediately: false })
    return module
  })
  return zxingReady
}

/** Reads `formats` with the browser's detector when it knows them all, else with zxing-wasm. */
export async function createFrameReader(formats: readonly ScannerFormat[]): Promise<FrameReader> {
  const Native = (globalThis as { BarcodeDetector?: NativeDetectorClass }).BarcodeDetector
  if (Native) {
    try {
      const supported = await Native.getSupportedFormats()
      if (formats.every(f => supported.includes(f))) {
        const detector = new Native({ formats: [...formats] })
        return {
          native: true,
          async read(frame) {
            // The native detector takes an image, not a Blob.
            const source = frame instanceof Blob ? await createImageBitmap(frame) : frame
            const [found] = await detector.detect(source)
            return found ? { value: found.rawValue, format: (SCANNER_FORMATS as readonly string[]).includes(found.format) ? found.format as ScannerFormat : null } : null
          }
        }
      }
    } catch {
      // A detector that can't say what it reads - zxing reads instead.
    }
  }
  const wanted = toZxingFormats(formats)
  let canvas: HTMLCanvasElement | null = null
  return {
    native: false,
    async read(frame) {
      const { readBarcodes } = await zxing()
      let input: Blob | ImageData
      if (frame instanceof Blob) input = frame
      else {
        const width = frame instanceof HTMLVideoElement ? frame.videoWidth : frame.width
        const height = frame instanceof HTMLVideoElement ? frame.videoHeight : frame.height
        if (!width || !height) return null
        canvas ??= document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) return null
        context.drawImage(frame, 0, 0, width, height)
        input = context.getImageData(0, 0, width, height)
      }
      const [found] = await readBarcodes(input, { formats: wanted as never[], tryHarder: true, maxNumberOfSymbols: 1 })
      return found?.isValid ? { value: found.text, format: fromZxingFormat(found.format) } : null
    }
  }
}

// --- Feedback ----------------------------------------------------------------

/** A short beep and/or a short vibration - what a reader does on a read. */
export function scanFeedback(options: { beep?: boolean, vibrate?: boolean }) {
  if (options.vibrate !== false) vibrate(80)
  if (options.beep !== false) playTones([{ frequency: 1760, duration: 0.09 }])
}

// --- The camera itself ------------------------------------------------------

/** Why a camera can't be opened, as the widget says it. */
export type CameraProblem = 'insecure' | 'unsupported' | 'denied' | 'missing' | 'failed'

/** The camera's stream, or why there is none - getUserMedia needs a secure context (HTTPS, or localhost). */
export async function openCamera(facing: 'environment' | 'user', ideal: { width: number, height: number }): Promise<{ stream: MediaStream } | { problem: CameraProblem, message: string }> {
  if (!window.isSecureContext) return { problem: 'insecure', message: 'The camera needs HTTPS.' }
  if (!navigator.mediaDevices?.getUserMedia) return { problem: 'unsupported', message: 'This browser has no camera access.' }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: ideal.width }, height: { ideal: ideal.height } }, audio: false })
    return { stream }
  } catch (error) {
    const name = error instanceof DOMException ? error.name : ''
    if (name === 'NotAllowedError' || name === 'SecurityError') return { problem: 'denied', message: 'Camera permission was denied.' }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return { problem: 'missing', message: 'No camera was found.' }
    return { problem: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}
