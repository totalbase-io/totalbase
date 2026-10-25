-- Access governance (Security.md §1.9-§1.11): roles that can't be held together, assignments that end, and which
-- roles are reviewed periodically.

-- Incompatible roles (segregation of duties, ISO/IEC 27002 5.3): no user holds both roles of a pair - whoever
-- operates doesn't audit. One row per pair, stored once (role < other).
CREATE TABLE totalbase.roles_incompatibilities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    role uuid NOT NULL,
    other uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT roles_incompatibilities_pkey PRIMARY KEY (id),
    CONSTRAINT roles_incompatibilities_ordered CHECK (role < other),
    CONSTRAINT roles_incompatibilities_pair_key UNIQUE (role, other),
    CONSTRAINT roles_incompatibilities_role_fkey FOREIGN KEY (role) REFERENCES totalbase.roles(id) ON DELETE CASCADE,
    CONSTRAINT roles_incompatibilities_other_fkey FOREIGN KEY (other) REFERENCES totalbase.roles(id) ON DELETE CASCADE
);
CREATE INDEX roles_incompatibilities_other_idx ON totalbase.roles_incompatibilities (other);

COMMENT ON TABLE totalbase.roles_incompatibilities IS 'Pairs of roles no user may hold together (Security.md §1.9), stored once with role < other. Written by administrators only.';

-- An assignment that ends (Security.md §1.10): past expires_at it grants nothing - the resolver reads assignments
-- live - and the hourly job removes it. NULL = until removed. Never on a reserved role: the instance's
-- administration and its system account don't lapse.
ALTER TABLE totalbase.users_roles ADD COLUMN expires_at timestamp with time zone;

COMMENT ON COLUMN totalbase.users_roles.expires_at IS 'When the assignment ends (Security.md §1.10); NULL = until removed.';

-- A pair, on every write path: no user may already hold both.
CREATE FUNCTION totalbase.roles_incompatibilities_unheld() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  holders integer;
BEGIN
  SELECT count(*) INTO holders FROM totalbase.users_roles a JOIN totalbase.users_roles b ON b."user" = a."user"
  WHERE a.role = NEW.role AND b.role = NEW.other
    AND (a.expires_at IS NULL OR a.expires_at > now()) AND (b.expires_at IS NULL OR b.expires_at > now());
  IF holders > 0 THEN
    RAISE EXCEPTION '% user(s) hold both roles - remove one of them first.', holders USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER roles_incompatibilities_unheld BEFORE INSERT OR UPDATE ON totalbase.roles_incompatibilities
  FOR EACH ROW EXECUTE FUNCTION totalbase.roles_incompatibilities_unheld();

-- An assignment, on every write path: never a role incompatible with one the user holds; never an expiry on a
-- reserved role.
CREATE FUNCTION totalbase.users_roles_compatible() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  clash text;
BEGIN
  IF NEW.expires_at IS NOT NULL AND EXISTS (SELECT 1 FROM totalbase.roles WHERE id = NEW.role AND reserved) THEN
    RAISE EXCEPTION 'A reserved role''s assignment doesn''t expire.' USING ERRCODE = '23514';
  END IF;
  SELECT r.name INTO clash
  FROM totalbase.users_roles a
  JOIN totalbase.roles_incompatibilities i ON (i.role = NEW.role AND i.other = a.role) OR (i.other = NEW.role AND i.role = a.role)
  JOIN totalbase.roles r ON r.id = a.role
  WHERE a."user" = NEW."user" AND a.id <> NEW.id AND (a.expires_at IS NULL OR a.expires_at > now())
  LIMIT 1;
  IF clash IS NOT NULL THEN
    RAISE EXCEPTION 'This user holds the "%" role, which can''t be held together with this one.', clash USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_roles_compatible BEFORE INSERT OR UPDATE ON totalbase.users_roles
  FOR EACH ROW EXECUTE FUNCTION totalbase.users_roles_compatible();

-- The triggers that read who holds what read live assignments only.
CREATE OR REPLACE FUNCTION totalbase.protect_admin_accounts() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  actor uuid := NULLIF(current_setting('totalbase.actor_user_id', true), '')::uuid;
BEGIN
  IF actor IS NULL OR actor = OLD.id THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF EXISTS (
    SELECT 1 FROM totalbase.users_roles a
    JOIN totalbase.roles r ON r.id = a.role
    WHERE a."user" = actor AND r.admin_access AND r.active AND (a.expires_at IS NULL OR a.expires_at > now())
  ) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF OLD.owner OR EXISTS (
    SELECT 1 FROM totalbase.users_roles a
    JOIN totalbase.roles r ON r.id = a.role
    WHERE a."user" = OLD.id AND r.admin_access
  ) THEN
    RAISE EXCEPTION 'An administrator''s account can only be changed by an administrator.'
      USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION totalbase.roles_keep_a_manager() RETURNS trigger
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
     OR EXISTS (SELECT 1 FROM totalbase.users_roles WHERE role = OLD.role AND (expires_at IS NULL OR expires_at > now())) THEN
    RETURN NULL;
  END IF;
  SELECT name INTO role_name FROM totalbase.roles WHERE id = OLD.role;
  IF role_name IS NULL THEN
    RETURN NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM totalbase.users_roles a
    JOIN totalbase.roles r ON r.id = a.role
    WHERE a."user" = actor AND r.admin_access AND r.active AND (a.expires_at IS NULL OR a.expires_at > now())
  ) THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'The "%" role manages other roles and would be left without members - ask an administrator.', role_name
    USING ERRCODE = '42501';
END;
$$;

-- Which roles are reviewed periodically (Security.md §1.8): Administrators always, and every role marked here.
ALTER TABLE totalbase.roles ADD COLUMN review_required boolean DEFAULT false NOT NULL;

COMMENT ON COLUMN totalbase.roles.review_required IS 'Whether its access is reviewed every auth.access_review_interval_days (Security.md §1.8), as the Administrators role always is.';
