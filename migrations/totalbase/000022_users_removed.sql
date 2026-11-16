-- Removing a user (Security.md §1.12): "this person is no longer in the organization" without deleting the
-- row - the audit log keeps resolving who did what - and without leaving a way back in, as deactivating
-- does. The row stays, inactive, with no password; its sessions are revoked and its tokens, factors,
-- identities, pending links and role assignments deleted, in the transaction that sets removed_at
-- (UsersService.remove). A removed account comes back by invitation only.

-- users is extensible (Foundations.md §10.4): a project that needed this before TotalBase had it may already hold a
-- removed_at of its own. One of the same type is taken as it is, with its values; any other type stops here.
ALTER TABLE totalbase.users ADD COLUMN IF NOT EXISTS removed_at timestamptz;
DO $$
DECLARE
  found text;
BEGIN
  SELECT format_type(atttypid, atttypmod) INTO found
    FROM pg_attribute
   WHERE attrelid = 'totalbase.users'::regclass AND attname = 'removed_at' AND NOT attisdropped;
  IF found <> 'timestamp with time zone' THEN
    RAISE EXCEPTION 'totalbase.users already has a column removed_at of type %, and TotalBase needs it as timestamptz', found
      USING HINT = 'Rename or convert that column, then start TotalBase again.';
  END IF;
END $$;
-- Never active while removed: reactivating one is not a way around the invitation.
ALTER TABLE totalbase.users ADD CONSTRAINT users_removed_inactive CHECK (removed_at IS NULL OR NOT active);
COMMENT ON COLUMN totalbase.users.removed_at IS 'When the account was removed (Security.md §1.12): inactive, with no credential left, the row kept for the audit log. NULL for an account that never was, or that was invited again.';
