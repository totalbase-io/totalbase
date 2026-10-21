/**
 * The device's position (DataViews.md §9.9, *Location*): one
 * call to the browser's Geolocation API, shared by the Location widget
 * (`TGeolocation`), the map field's *My location* (`TLeafletMap.locate()`)
 * and the Code's `dataview.device.location()`. A point is `{ lng, lat }`,
 * the column's own wire shape; the accuracy (meters) rides beside it for
 * whoever wants it, never inside the value.
 *
 * Never a watch: a position is captured when asked, once.
 */

export interface DeviceLocation {
  lng: number
  lat: number
  /** The browser's accuracy radius, in meters. */
  accuracy: number
}

/** Why there is no position, as the widget says it. */
export type LocationProblem = 'insecure' | 'unsupported' | 'denied' | 'unavailable' | 'timeout'

export class DeviceLocationError extends Error {
  constructor(readonly reason: LocationProblem, message: string) {
    super(message)
    this.name = 'DeviceLocationError'
  }
}

export interface LocationOptions {
  /** GPS over the network's guess - slower, exact (default on). */
  highAccuracy?: boolean
  /** Milliseconds to wait for a fix (default 10 000). */
  timeout?: number
  /** A cached position no older than this many milliseconds is fine (default 0: a fresh one). */
  maxAge?: number
}

/** The device's position now, or a DeviceLocationError saying why not - the Geolocation API needs a secure context (HTTPS, or localhost). */
export function currentLocation(options: LocationOptions = {}): Promise<DeviceLocation> {
  if (typeof window === 'undefined' || !window.isSecureContext) return Promise.reject(new DeviceLocationError('insecure', 'The location needs HTTPS.'))
  if (!navigator.geolocation) return Promise.reject(new DeviceLocationError('unsupported', 'This browser has no location access.'))
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      position => resolve({ lng: position.coords.longitude, lat: position.coords.latitude, accuracy: position.coords.accuracy }),
      (error) => {
        if (error.code === error.PERMISSION_DENIED) reject(new DeviceLocationError('denied', 'Location access was denied.'))
        else if (error.code === error.TIMEOUT) reject(new DeviceLocationError('timeout', 'No position in time.'))
        else reject(new DeviceLocationError('unavailable', 'The position is unavailable.'))
      },
      { enableHighAccuracy: options.highAccuracy ?? true, timeout: options.timeout ?? 10_000, maximumAge: options.maxAge ?? 0 }
    )
  })
}

/** `reason` of whatever `currentLocation` rejected with - `unavailable` for anything else. */
export function locationProblem(error: unknown): LocationProblem {
  return error instanceof DeviceLocationError ? error.reason : 'unavailable'
}
