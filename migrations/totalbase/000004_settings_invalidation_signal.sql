-- Several server processes per instance (Foundations.md §4.6): each keeps the settings in memory, so a change
-- one of them writes - or that the SQL Console writes - is told to every other one. PostgreSQL sends it at
-- COMMIT, never on ROLLBACK, on the channel each process LISTENs on. A TRUNCATE says "every key" (no key).
CREATE FUNCTION totalbase.notify_settings_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    PERFORM pg_notify('totalbase_invalidations', json_build_object('topic', 'SETTINGS')::text);
  ELSE
    PERFORM pg_notify('totalbase_invalidations', json_build_object('topic', 'SETTINGS', 'key', COALESCE(NEW.key, OLD.key))::text);
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION totalbase.notify_settings_change() IS 'Tells every server process that a setting changed (NOTIFY totalbase_invalidations), so none keeps an old value.';

CREATE TRIGGER settings_invalidation AFTER INSERT OR UPDATE OR DELETE ON totalbase.settings
  FOR EACH ROW EXECUTE FUNCTION totalbase.notify_settings_change();

CREATE TRIGGER settings_invalidation_truncate AFTER TRUNCATE ON totalbase.settings
  FOR EACH STATEMENT EXECUTE FUNCTION totalbase.notify_settings_change();
