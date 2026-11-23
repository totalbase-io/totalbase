-- A secret serves one feature (Security.md §12.3): SMTP, S3, dashboard embeds, auth providers or workflows. Each
-- feature decrypts only its own, so a setting pointed at another secret's key (SMTP aimed at a host of one's own,
-- then Verify) can't hand that host a provider's or a workflow's credential.
ALTER TABLE totalbase.secrets ADD COLUMN scope text;

-- What each secret serves today, from what names it; anything else is a workflow's (HTTP, SOAP and Sign steps).
UPDATE totalbase.secrets s SET scope = CASE
  WHEN EXISTS (SELECT 1 FROM totalbase.providers p WHERE p.configuration->>'client_secret_key' = s.key) THEN 'AUTH_PROVIDERS'
  WHEN EXISTS (SELECT 1 FROM totalbase.settings t WHERE t.key = 'smtp.password_secret_key' AND t.value = to_jsonb(s.key)) THEN 'SMTP'
  WHEN EXISTS (SELECT 1 FROM totalbase.settings t WHERE t.key = 's3.secret_key' AND t.value = to_jsonb(s.key)) THEN 'S3'
  WHEN EXISTS (SELECT 1 FROM totalbase.settings t WHERE t.key = 'dashboards.embed_secret_key' AND t.value = to_jsonb(s.key)) THEN 'DASHBOARD_EMBEDS'
  ELSE 'WORKFLOWS'
END;

ALTER TABLE totalbase.secrets ALTER COLUMN scope SET NOT NULL;
ALTER TABLE totalbase.secrets ADD CONSTRAINT secrets_scope_check
  CHECK (scope IN ('SMTP', 'S3', 'DASHBOARD_EMBEDS', 'AUTH_PROVIDERS', 'WORKFLOWS'));

-- A secret moves to another feature only with a new value: whoever moves it has to know what it holds, so moving
-- never reveals one. PostgreSQL enforces it for every path (the Admin API, the Data API, SQL).
CREATE FUNCTION totalbase.secrets_scope_moves_with_value() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.scope IS DISTINCT FROM OLD.scope AND NEW.ciphertext IS NOT DISTINCT FROM OLD.ciphertext THEN
    RAISE EXCEPTION 'A secret changes feature only with a new value.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER secrets_scope_moves_with_value BEFORE UPDATE OF scope ON totalbase.secrets
  FOR EACH ROW EXECUTE FUNCTION totalbase.secrets_scope_moves_with_value();

COMMENT ON COLUMN totalbase.secrets.scope IS 'The one feature that may decrypt this secret (Security.md §12.3): SMTP, S3, DASHBOARD_EMBEDS, AUTH_PROVIDERS or WORKFLOWS. Changes only together with the value.';
