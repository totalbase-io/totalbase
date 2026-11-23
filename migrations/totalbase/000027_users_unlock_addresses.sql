-- An administrator's Unlock account (a Data API row update on users, Security.md §2.4) ends every lock of the
-- account: its own, the account-wide sign-in delay, and each address's - which no route reaches otherwise. It is the
-- update that clears the delay (`sign_in_failures` 0 and `sign_in_delayed_until` NULL); a sign-in's own success
-- leaves `sign_in_delayed_until` at now(), never NULL, so it never frees the addresses an attacker locked.
CREATE FUNCTION totalbase.users_unlock_addresses() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  UPDATE totalbase.users_addresses SET failed_count = 0, locked_until = NULL, updated_at = now()
   WHERE "user" = NEW.id AND (failed_count > 0 OR locked_until IS NOT NULL);
  RETURN NULL;
END
$$;

CREATE TRIGGER users_unlock_addresses AFTER UPDATE OF sign_in_failures, sign_in_delayed_until ON totalbase.users
  FOR EACH ROW WHEN (NEW.sign_in_failures = 0 AND NEW.sign_in_delayed_until IS NULL)
  EXECUTE FUNCTION totalbase.users_unlock_addresses();
