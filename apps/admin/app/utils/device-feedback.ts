/**
 * A short tone and a vibration - what the Scanner (a read) and the Result
 * (an outcome) confirm with (Specification_DataViews.md §9.9, §9.11). Web
 * Audio, no sound files; a device without audio or vibration stays silent.
 */

/** One note: its pitch in Hz and how long it sounds, in seconds. */
export interface ToneNote {
  frequency: number
  duration: number
}

let audio: AudioContext | null = null

/** Plays `notes` one after the other, quietly. */
export function playTones(notes: readonly ToneNote[], volume = 0.08) {
  try {
    audio ??= new AudioContext()
    // A context created before any gesture starts suspended - a kiosk's first result may come from a scan.
    if (audio.state === 'suspended') void audio.resume()
    let at = audio.currentTime
    for (const note of notes) {
      const oscillator = audio.createOscillator()
      const gain = audio.createGain()
      oscillator.frequency.value = note.frequency
      gain.gain.value = volume
      oscillator.connect(gain).connect(audio.destination)
      oscillator.start(at)
      oscillator.stop(at + note.duration)
      at += note.duration
    }
  } catch {
    // No audio on this device - what it confirms stands.
  }
}

/** A vibration, where the device can - a length in ms or an on/off pattern. */
export function vibrate(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern)
  } catch {
    // No vibration here.
  }
}
