import type { AdminApiError as AdminApiErrorShape } from '~/types/api'

/**
 * Thrown by useAdminApi() for every non-2xx response. Carries the server's
 * own code/message through untouched — the UI's job is to display it, not
 * to reinterpret it (Admin_UI.md §1.2: no logic that belongs server-side).
 */
export class AdminApiError extends Error {
  readonly status: number
  readonly code: string
  readonly source: 'TOTALBASE' | 'POSTGRESQL'
  readonly allErrors: AdminApiErrorShape[]

  constructor(status: number, errors: AdminApiErrorShape[]) {
    const first = errors[0]
    super(first?.message ?? `Request failed with status ${status}`)
    this.name = 'AdminApiError'
    this.status = status
    this.code = first?.code ?? 'UNKNOWN_ERROR'
    this.source = first?.source ?? 'TOTALBASE'
    this.allErrors = errors
  }

  /** Every error of the response, as the API sent them - what a CUSTOM page's handler reads (`error.errors`). */
  get errors(): AdminApiErrorShape[] {
    return this.allErrors
  }
}
