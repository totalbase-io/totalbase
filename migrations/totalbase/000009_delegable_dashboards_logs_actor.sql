-- A dashboard an administrator vouches for (Security.md §9.7): its widgets' SQL bypasses the resolver
-- (Dashboards.md §2), so a role's ceiling doesn't contain it - a manager may open it to the roles below theirs
-- only once an administrator marked it delegable, its queries written with $USER.*.
ALTER TABLE totalbase.dashboards ADD COLUMN delegable boolean DEFAULT false NOT NULL;

COMMENT ON COLUMN totalbase.dashboards.delegable IS 'Whether a manager may open it to the roles below theirs (Security.md §9.7) - an administrator''s word that its SQL is written with $USER.*.';

-- The user who acted (Security.md §11.2): the principal for a user's session or the Admin API, a token's owner
-- for a token, nobody for TotalBase's own work. A real foreign key, so a grant on logs can follow it - a site's
-- manager reads their site's activity with actor.site = $USER.site, through the one filter grammar.
ALTER TABLE totalbase.logs ADD COLUMN actor uuid;
ALTER TABLE totalbase.logs ADD CONSTRAINT logs_actor_fkey FOREIGN KEY (actor) REFERENCES totalbase.users(id) ON DELETE SET NULL;
CREATE INDEX logs_actor_idx ON totalbase.logs (actor, created_at);

COMMENT ON COLUMN totalbase.logs.actor IS 'The user who acted (Security.md §11.2): the principal, or a token''s owner; NULL for TotalBase''s own work or an account since deleted.';

CREATE FUNCTION totalbase.logs_actor() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.actor := CASE NEW.principal_type
    WHEN 'USER' THEN NEW.principal
    WHEN 'ADMIN' THEN NEW.principal
    WHEN 'API_KEY' THEN (SELECT t."user" FROM totalbase.tokens t WHERE t.id = NEW.principal)
  END;
  IF NEW.actor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM totalbase.users WHERE id = NEW.actor) THEN
    NEW.actor := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER logs_actor BEFORE INSERT ON totalbase.logs FOR EACH ROW EXECUTE FUNCTION totalbase.logs_actor();
