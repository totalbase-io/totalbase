-- The Workflows role guard answers with its own SQLSTATE (insufficient_privilege, 42501 - a 403 to the API) instead
-- of a generic RAISE EXCEPTION: the trigger is the one check, so a role assignment no longer asks first
-- (AGENTS.md §16) and a refusal still says what it is.

CREATE OR REPLACE FUNCTION totalbase.protect_workflows_role_assignment() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  workflows_role_id uuid;
  workflows_user_id uuid;
BEGIN
  SELECT id INTO workflows_role_id FROM totalbase.roles WHERE name = 'Workflows';
  IF workflows_role_id IS NULL OR NEW.role <> workflows_role_id THEN
    RETURN NEW;
  END IF;

  SELECT id INTO workflows_user_id FROM totalbase.users WHERE email = 'workflows@system.totalbase.internal';
  IF workflows_user_id IS NULL OR NEW."user" <> workflows_user_id THEN
    RAISE EXCEPTION 'The Workflows role is reserved for TotalBase''s own system account and cannot be assigned to any other user.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;
