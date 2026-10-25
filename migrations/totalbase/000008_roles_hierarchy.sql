-- Role hierarchy (Security.md §9.5): a role's parent is its ceiling - it can do at most what its ancestors can,
-- resolved live (§6.11) - and the scope of whoever manages it: a holder of MANAGE_ROLES manages the subtree
-- below their role. Not inheritance: a child receives nothing from its parent. NULL = a root, no ceiling, as
-- every role was before. A role with children isn't deleted (RESTRICT): its subtree goes first, or moves.
ALTER TABLE totalbase.roles ADD COLUMN parent uuid;
ALTER TABLE totalbase.roles ADD CONSTRAINT roles_parent_fkey FOREIGN KEY (parent) REFERENCES totalbase.roles(id) ON DELETE RESTRICT;
ALTER TABLE totalbase.roles ADD CONSTRAINT roles_parent_not_self CHECK (parent <> id);
CREATE INDEX roles_parent_idx ON totalbase.roles (parent);

COMMENT ON COLUMN totalbase.roles.parent IS 'The role above this one (Security.md §9.5): its ceiling and its managers'' scope. NULL = a root.';

-- The tree's shape, on every write path: never a reserved or administrative role in it (administrators sit
-- above every tree), never a cycle, at most four levels from root to the deepest leaf.
CREATE FUNCTION totalbase.roles_parent_valid() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  above integer;
  below integer;
BEGIN
  IF NEW.parent IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.reserved OR NEW.admin_access THEN
    RAISE EXCEPTION 'A reserved or administrative role is never placed under another role.' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM totalbase.roles WHERE id = NEW.parent AND (reserved OR admin_access)) THEN
    RAISE EXCEPTION 'A reserved or administrative role has no roles under it.' USING ERRCODE = '23514';
  END IF;
  -- The parent's ancestors, the parent included: NEW among them is a cycle.
  WITH RECURSIVE up AS (
    SELECT id, parent, 1 AS depth FROM totalbase.roles WHERE id = NEW.parent
    UNION ALL
    SELECT r.id, r.parent, up.depth + 1 FROM totalbase.roles r JOIN up ON r.id = up.parent WHERE up.depth < 16
  )
  SELECT CASE WHEN bool_or(id = NEW.id) THEN -1 ELSE max(depth) END INTO above FROM up;
  IF above = -1 THEN
    RAISE EXCEPTION 'A role can''t be placed under one of its own descendants.' USING ERRCODE = '23514';
  END IF;
  -- The deepest level under NEW (0 = a leaf), for a role moved with its subtree.
  WITH RECURSIVE down AS (
    SELECT id, 0 AS depth FROM totalbase.roles WHERE id = NEW.id
    UNION ALL
    SELECT r.id, down.depth + 1 FROM totalbase.roles r JOIN down ON r.parent = down.id WHERE down.depth < 16
  )
  SELECT coalesce(max(depth), 0) INTO below FROM down;
  IF above + 1 + below > 4 THEN
    RAISE EXCEPTION 'Roles nest at most four levels deep.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER roles_parent_valid BEFORE INSERT OR UPDATE OF parent, reserved, admin_access ON totalbase.roles
  FOR EACH ROW EXECUTE FUNCTION totalbase.roles_parent_valid();

-- Who granted it (Security.md §5.1): the acting user of a write made on someone's behalf, else what the
-- Admin API's service stated - never a request payload's word (grants are written by services only).
ALTER TABLE totalbase.permissions ADD COLUMN granted_by uuid;
ALTER TABLE totalbase.permissions ADD CONSTRAINT permissions_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES totalbase.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN totalbase.permissions.granted_by IS 'The user who wrote this grant (Security.md §5.1); NULL = TotalBase itself, or an account since deleted.';

CREATE FUNCTION totalbase.permissions_granted_by() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  actor uuid := NULLIF(current_setting('totalbase.actor_user_id', true), '')::uuid;
BEGIN
  IF actor IS NOT NULL THEN
    NEW.granted_by := actor;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER permissions_granted_by BEFORE INSERT OR UPDATE ON totalbase.permissions
  FOR EACH ROW EXECUTE FUNCTION totalbase.permissions_granted_by();

-- MANAGE_ROLES (Security.md §9.5): a role's members manage the roles below it.
ALTER TABLE totalbase.roles_capabilities DROP CONSTRAINT roles_capabilities_capability_check;
ALTER TABLE totalbase.roles_capabilities ADD CONSTRAINT roles_capabilities_capability_check
  CHECK (capability = ANY (ARRAY['TRANSACTIONS'::text, 'SEND_EMAIL'::text, 'MANAGE_ROLES'::text]));
