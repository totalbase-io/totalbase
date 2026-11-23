/** The one feature a secret serves (Security.md §12.3) - only that feature reads it. */
export const SECRET_SCOPES = ['SMTP', 'S3', 'DASHBOARD_EMBEDS', 'AUTH_PROVIDERS', 'WORKFLOWS'] as const
export type SecretScope = typeof SECRET_SCOPES[number]

export interface SecretMetadata {
  key: string
  scope: SecretScope
  createdAt: string
  updatedAt: string
}
