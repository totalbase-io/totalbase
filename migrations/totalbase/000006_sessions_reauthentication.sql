-- Re-authentication (Security.md §2.19): when a session last confirmed its user's identity - their password or
-- second factor - for the operations that ask for it (issuing an administrator token, assigning Administrators,
-- another account's email, password or second factor). A sign-in counts as one: NULL means only created_at.
ALTER TABLE totalbase.sessions ADD COLUMN reauthenticated_at timestamp with time zone;

COMMENT ON COLUMN totalbase.sessions.reauthenticated_at IS 'When the session last confirmed its user''s password or second factor (Security.md §2.19); NULL = only its sign-in.';

-- A write made on someone's behalf still only revokes: the new column is kept like every other.
CREATE OR REPLACE FUNCTION totalbase.sessions_only_revocation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NULLIF(current_setting('totalbase.actor_user_id', true), '') IS NULL THEN
    RETURN NEW;
  END IF;
  NEW.id := OLD.id;
  NEW."user" := OLD."user";
  NEW.token_hash := OLD.token_hash;
  NEW.ip := OLD.ip;
  NEW.user_agent := OLD.user_agent;
  NEW.created_at := OLD.created_at;
  NEW.last_seen_at := OLD.last_seen_at;
  NEW.expires_at := OLD.expires_at;
  NEW.mfa_verified_at := OLD.mfa_verified_at;
  NEW.reauthenticated_at := OLD.reauthenticated_at;
  NEW.revoked_at := CASE
    WHEN OLD.revoked_at IS NOT NULL THEN OLD.revoked_at
    WHEN NEW.revoked_at IS NOT NULL THEN now()
    ELSE NULL
  END;
  RETURN NEW;
END;
$$;
