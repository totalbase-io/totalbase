-- Self-managed roles (Security.md §9.4): a role may manage itself, so an administrator can let "Site managers"
-- add another site manager - the lateral case; the row filters on users and users_roles keep it to their own
-- organization. Still an explicit pair an administrator sets, never implied by holding a role.
ALTER TABLE totalbase.roles_managers DROP CONSTRAINT roles_managers_check;

-- A role that manages others is never left without members by a non-administrator (Security.md §1.7): the
-- last site manager removing themselves - or another manager, or deleting their account - would leave the
-- organization with no one to manage it. Checked at commit (deferred), so replacing one manager with another in
-- a transaction still works. An administrator, and TotalBase's own writes (no actor), may; a deleted role,
-- or one that manages nothing, has nothing to keep.
CREATE FUNCTION totalbase.roles_keep_a_manager() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  actor uuid := NULLIF(current_setting('totalbase.actor_user_id', true), '')::uuid;
  role_name text;
BEGIN
  IF actor IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM totalbase.roles_managers WHERE manager = OLD.role)
     OR EXISTS (SELECT 1 FROM totalbase.users_roles WHERE role = OLD.role) THEN
    RETURN NULL;
  END IF;
  SELECT name INTO role_name FROM totalbase.roles WHERE id = OLD.role;
  IF role_name IS NULL THEN
    RETURN NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM totalbase.users_roles a
    JOIN totalbase.roles r ON r.id = a.role
    WHERE a."user" = actor AND r.admin_access AND r.active
  ) THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'The "%" role manages other roles and would be left without members - ask an administrator.', role_name
    USING ERRCODE = '42501';
END;
$$;

CREATE CONSTRAINT TRIGGER users_roles_keep_a_manager AFTER DELETE OR UPDATE ON totalbase.users_roles
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION totalbase.roles_keep_a_manager();
