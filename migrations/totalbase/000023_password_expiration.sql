-- Password expiration (Security.md §2.20): when the current password was set, and whether an administrator asked
-- for it to be changed at the next sign-in. auth.password_max_age_days ages the first; either one makes a
-- password sign-in answer PASSWORD_CHANGE_REQUIRED with a challenge instead of a session.

-- users is extensible (Foundations.md §10.4): a project may already hold columns by these names. One of the
-- same type is taken as it is, with its values; any other type stops here.
ALTER TABLE totalbase.users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;
ALTER TABLE totalbase.users ADD COLUMN IF NOT EXISTS password_change_required boolean;
DO $$
DECLARE
  wanted record;
  found text;
BEGIN
  FOR wanted IN
    SELECT * FROM (VALUES ('password_changed_at', 'timestamp with time zone', 'timestamptz'),
                          ('password_change_required', 'boolean', 'boolean')) AS w(name, type, label)
  LOOP
    SELECT format_type(atttypid, atttypmod) INTO found
      FROM pg_attribute
     WHERE attrelid = 'totalbase.users'::regclass AND attname = wanted.name AND NOT attisdropped;
    IF found <> wanted.type THEN
      RAISE EXCEPTION 'totalbase.users already has a column % of type %, and TotalBase needs it as %', wanted.name, found, wanted.label
        USING HINT = 'Rename or convert that column, then start TotalBase again.';
    END IF;
  END LOOP;
END $$;

-- The age of the passwords already set is unknown: their clock starts here.
UPDATE totalbase.users SET password_changed_at = now() WHERE password_hash IS NOT NULL AND password_changed_at IS NULL;
UPDATE totalbase.users SET password_change_required = false WHERE password_change_required IS NULL OR password_hash IS NULL;
ALTER TABLE totalbase.users ALTER COLUMN password_change_required SET DEFAULT false;
ALTER TABLE totalbase.users ALTER COLUMN password_change_required SET NOT NULL;

COMMENT ON COLUMN totalbase.users.password_changed_at IS 'When the current password was set (Security.md §2.20); NULL without one. Kept by the trigger users_password_changed_at - no write sets it.';
COMMENT ON COLUMN totalbase.users.password_change_required IS 'The password must be changed at the next password sign-in (Security.md §2.20). Cleared by the trigger users_password_changed_at when the password changes.';

-- PostgreSQL dates the password, whatever path writes it: a new hash is dated now and clears the request to
-- change it; no password, no date and nothing to change; any other write keeps the date it had.
CREATE FUNCTION totalbase.users_password_changed_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.password_hash IS NULL THEN
    NEW.password_changed_at := NULL;
    NEW.password_change_required := false;
  ELSIF TG_OP = 'INSERT' THEN
    NEW.password_changed_at := now();
  ELSIF NEW.password_hash IS DISTINCT FROM OLD.password_hash THEN
    NEW.password_changed_at := now();
    NEW.password_change_required := false;
  ELSE
    NEW.password_changed_at := OLD.password_changed_at;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_password_changed_at BEFORE INSERT OR UPDATE ON totalbase.users
    FOR EACH ROW EXECUTE FUNCTION totalbase.users_password_changed_at();

-- The step where a due password is changed is a challenge like the second factor's (Security.md §2.17), with
-- its own purpose. password_sign_in: the sign-in presented the account's password (a provider's didn't, and is
-- never asked to change it). mfa_verified: the sign-in already passed its second factor, so its session has.
ALTER TABLE totalbase.challenges DROP CONSTRAINT challenges_purpose_check;
ALTER TABLE totalbase.challenges ADD CONSTRAINT challenges_purpose_check CHECK (purpose = ANY (ARRAY['VERIFY'::text, 'ENROLL'::text, 'PASSWORD'::text]));
ALTER TABLE totalbase.challenges ADD COLUMN password_sign_in boolean NOT NULL DEFAULT false;
ALTER TABLE totalbase.challenges ADD COLUMN mfa_verified boolean NOT NULL DEFAULT false;

COMMENT ON TABLE totalbase.challenges IS 'A step between a correct password and a session - a second factor due, or a password to change first: single-use, about five minutes, stored as a hash.';
COMMENT ON COLUMN totalbase.challenges.password_sign_in IS 'The sign-in this step belongs to presented the account''s password - a due password is changed before its session (Security.md §2.20).';
COMMENT ON COLUMN totalbase.challenges.mfa_verified IS 'The sign-in passed its second factor before this step (a PASSWORD challenge issued after a VERIFY one).';
