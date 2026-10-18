/**
 * System emails (Templates → System) - the fixed messages TotalBase sends
 * itself, served by /admin/api/system-emails. Shapes mirror
 * apps/server/src/routes/admin-system-emails.ts.
 */
export interface SystemEmailTemplate {
  subject: string
  html: string
  text: string
}

export interface SystemEmailSummary {
  slot: string
  label: string
  description: string
  /** Carries a single-use link - `{{action_url}}` is required. */
  hasAction: boolean
  variables: string[]
  /** An admin edit is stored; false = the built-in default is used. */
  overridden: boolean
  /** null = always sent when its flow runs; otherwise whether it's switched on. */
  enabled: boolean | null
  enabledSetting: string | null
}

export interface SystemEmail extends SystemEmailSummary {
  template: SystemEmailTemplate
  defaultTemplate: SystemEmailTemplate
}

/** `{{name}}` - built here so templates never need a literal mustache pair. */
export function placeholder(name: string): string {
  return `{${'{'}${name}}${'}'}`
}

/** Each variable's help, as an i18n key (`content.systemEmails.variables.*`) - translated where it's shown. */
export const SYSTEM_EMAIL_VARIABLE_HELP: Record<string, string> = {
  'user.name': 'content.systemEmails.variables.userName',
  'user.email': 'content.systemEmails.variables.userEmail',
  'instance.name': 'content.systemEmails.variables.instanceName',
  'instance.public_url': 'content.systemEmails.variables.instancePublicUrl',
  'action_url': 'content.systemEmails.variables.actionUrl',
  'expires_in': 'content.systemEmails.variables.expiresIn',
  'new_email': 'content.systemEmails.variables.newEmail'
}
