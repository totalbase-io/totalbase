-- MFA's settings have their own group (Security.md §2.17, Administration.md §7): `auth.mfa_required` became
-- `mfa.required` (NONE, EVERYONE or ROLES, with `mfa.required_roles`) and `auth.mfa_disabled_email_enabled`
-- `mfa.disabled_email_enabled`. The old keys are no longer in the registry; their stored overrides go.
DELETE FROM totalbase.settings WHERE key IN ('auth.mfa_required', 'auth.mfa_disabled_email_enabled');
