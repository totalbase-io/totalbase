-- TotalBase baseline: the totalbase schema as the beta installs it, the development migrations folded
-- into one (Specification.md §16, squashed 2026-10-16; its tables named without a prefix, the schema being
-- their namespace, 2026-10-17). Taken with pg_dump from a database those migrations built; the migration
-- runner has already created the schema and its ledger, totalbase.migrations (packages/migrations
-- runner.ts). Every later change is a migration of its own after this one.

-- The Data API's `search` (Specification_Data_API.md §3.5) compares text through one function: lower case
-- and, when the `unaccent` contrib extension is available, without diacritics. `unaccent` is a trusted
-- extension (PostgreSQL 13+): a database owner installs it without SUPERUSER; where even that is refused,
-- the search ignores case only - a NOTICE says so (AGENTS.md §4A). IMMUTABLE so an operator may index it.
-- It runs before search_path is emptied below: the extension goes where this database creates them.
DO $$
DECLARE
  unaccent_schema text;
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS unaccent;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'search: the unaccent extension could not be installed (%) - search ignores case, not accents', SQLERRM;
  END;

  SELECT n.nspname INTO unaccent_schema
  FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'unaccent';

  IF unaccent_schema IS NOT NULL THEN
    EXECUTE format(
      'CREATE FUNCTION totalbase.search_normalize(text) RETURNS text
         LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
         RETURN lower(%I.unaccent(%L::regdictionary, $1))',
      unaccent_schema, unaccent_schema || '.unaccent');
  ELSE
    EXECUTE
      'CREATE FUNCTION totalbase.search_normalize(text) RETURNS text
         LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
         RETURN lower($1)';
  END IF;
END
$$;

COMMENT ON FUNCTION totalbase.search_normalize(text) IS
  'How the Data API''s search compares text: lower case, without accents when unaccent is installed. Index it for a large table: CREATE INDEX ... USING gin (totalbase.search_normalize(col) gin_trgm_ops).';

-- From here on every name is schema-qualified, as pg_dump wrote it.
SELECT pg_catalog.set_config('search_path', '', true);
SET LOCAL check_function_bodies = false;

--
--

CREATE FUNCTION totalbase.roles_reviews_fill() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'An access review cannot be changed once recorded.' USING ERRCODE = 'check_violation';
  END IF;
  -- Who reviewed: the acting user of the write (Specification_Security.md §10.3), never a value the client sends.
  NEW.reviewer := nullif(current_setting('totalbase.actor_user_id', true), '')::uuid;
  IF NEW.reviewer IS NULL THEN
    RAISE EXCEPTION 'An access review is recorded by a signed-in administrator.' USING ERRCODE = 'check_violation';
  END IF;
  NEW.created_at := now();
  -- Who held the role when it was reviewed.
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'email', u.email, 'name', u.name) ORDER BY u.email), '[]'::jsonb)
    INTO NEW.members
    FROM totalbase.users_roles a
    JOIN totalbase.users u ON u.id = a."user"
   WHERE a.role = NEW.role;
  RETURN NEW;
END $$;

CREATE FUNCTION totalbase.tokens_limited_changes() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NULLIF(current_setting('totalbase.actor_user_id', true), '') IS NULL THEN
    RETURN NEW;
  END IF;
  NEW.id := OLD.id;
  NEW."user" := OLD."user";
  NEW.plane := OLD.plane;
  NEW.key_prefix := OLD.key_prefix;
  NEW.key_hash := OLD.key_hash;
  NEW.previous_key_hash := OLD.previous_key_hash;
  NEW.previous_expires_at := OLD.previous_expires_at;
  NEW.expires_at := OLD.expires_at;
  NEW.last_used_at := OLD.last_used_at;
  NEW.rotated_at := OLD.rotated_at;
  NEW.created_at := OLD.created_at;
  NEW.revoked_at := CASE
    WHEN OLD.revoked_at IS NOT NULL THEN OLD.revoked_at
    WHEN NEW.revoked_at IS NOT NULL THEN now()
    ELSE NULL
  END;
  RETURN NEW;
END;
$$;

CREATE FUNCTION totalbase.tokens_touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (to_jsonb(NEW) - 'last_used_at' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'last_used_at' - 'updated_at') THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION totalbase.users_roles_owner_keeps_administrators() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM totalbase.users u
    WHERE u.id = OLD."user" AND u.owner
      AND NOT EXISTS (
        SELECT 1 FROM totalbase.users_roles a
        JOIN totalbase.roles r ON r.id = a.role
        WHERE a."user" = u.id AND r.reserved AND r.admin_access AND r.name = 'Administrators'
      )
  ) THEN
    RAISE EXCEPTION 'The instance owner cannot lose the Administrators role.' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION totalbase.bump_openapi_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO totalbase.invalidations (topic) VALUES ('OPENAPI');
  RETURN NULL;
END;
$$;

CREATE FUNCTION totalbase.dataview_column_presentation(p_dataview uuid) RETURNS jsonb
    LANGUAGE sql STABLE
    AS $_$
  WITH d AS (
    SELECT id, source_resource, view_config FROM totalbase.dataviews WHERE id = p_dataview
  ),
  variable_refs AS (
    SELECT (v ->> 'resource')::uuid AS resource
    FROM d, jsonb_array_elements(
      CASE WHEN jsonb_typeof(d.view_config -> 'variables') = 'array' THEN d.view_config -> 'variables' ELSE '[]'::jsonb END
    ) AS v
    WHERE v ->> 'kind' = 'RESOURCE'
      AND v ->> 'resource' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ),
  refs AS (
    SELECT d.source_resource AS resource FROM d WHERE d.source_resource IS NOT NULL
    UNION
    SELECT resource FROM variable_refs
    UNION
    SELECT target.id
    FROM d
    JOIN totalbase.resources source ON source.id = d.source_resource
    JOIN totalbase.dataviews_fields f ON f.dataview = d.id AND f.kind = 'RELATED'
    JOIN pg_catalog.pg_constraint c
      ON c.conrelid = source.postgres_oid AND c.contype = 'f' AND c.conkey = ARRAY[f.relation_attnum]::int2[]
    JOIN totalbase.resources target ON target.postgres_oid = c.confrelid AND target.status = 'ACTIVE'
    UNION
    -- What each Resource's foreign keys point at: its related columns' titles.
    SELECT target.id
    FROM variable_refs vr
    JOIN totalbase.resources source ON source.id = vr.resource
    JOIN pg_catalog.pg_constraint c ON c.conrelid = source.postgres_oid AND c.contype = 'f' AND array_length(c.conkey, 1) = 1
    JOIN totalbase.resources target ON target.postgres_oid = c.confrelid AND target.status = 'ACTIVE'
  )
  SELECT COALESCE(jsonb_object_agg(m.resource, m.columns), '{}'::jsonb)
  FROM (
    SELECT refs.resource, totalbase.resource_column_presentation(refs.resource) AS columns
    FROM refs
  ) m
  WHERE m.columns <> '{}'::jsonb
$_$;

CREATE FUNCTION totalbase.dataview_presentation(p_dataview uuid) RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
  SELECT jsonb_build_object(
    'columns', totalbase.dataview_column_presentation(p_dataview),
    'rows', totalbase.dataview_row_presentation(p_dataview)
  )
$$;

CREATE FUNCTION totalbase.dataview_row_presentation(p_dataview uuid) RETURNS jsonb
    LANGUAGE sql STABLE
    AS $_$
  WITH d AS (
    SELECT id, source_resource, view_config FROM totalbase.dataviews WHERE id = p_dataview
  ),
  sources AS (
    SELECT d.source_resource AS resource FROM d WHERE d.source_resource IS NOT NULL
    UNION
    SELECT (v ->> 'resource')::uuid
    FROM d, jsonb_array_elements(
      CASE WHEN jsonb_typeof(d.view_config -> 'variables') = 'array' THEN d.view_config -> 'variables' ELSE '[]'::jsonb END
    ) AS v
    WHERE v ->> 'kind' = 'RESOURCE'
      AND v ->> 'resource' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  )
  SELECT COALESCE(jsonb_object_agg(t.id, t.row_presentation), '{}'::jsonb)
  FROM (
    SELECT DISTINCT target.id, target.row_presentation
    FROM sources s
    JOIN totalbase.resources source ON source.id = s.resource
    JOIN pg_catalog.pg_constraint c ON c.conrelid = source.postgres_oid AND c.contype = 'f'
    JOIN totalbase.resources target
      ON target.postgres_oid = c.confrelid AND target.type IN ('TABLE', 'VIEW') AND target.status = 'ACTIVE'
    WHERE target.row_presentation <> '{}'::jsonb
  ) t
$_$;

CREATE FUNCTION totalbase.instance_protect_id() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.id <> OLD.id THEN
    RAISE EXCEPTION 'instance.id is immutable';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION totalbase.instance_protect_id() IS 'Rejects any UPDATE on totalbase.instance that changes id.';

CREATE FUNCTION totalbase.is_valid_name(value text) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $_$
  SELECT value = btrim(value)
    AND length(value) BETWEEN 1 AND 32
    AND value !~ '[\x01-\x1f\x7f-\x9f​-‏‪-‮⁦-⁩﻿]'
    AND value !~ '[!"#$%*/<=>?@\[\\\]^`{|}~]'
$_$;

CREATE FUNCTION totalbase.menus_parent_is_group() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.parent IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM totalbase.menus WHERE id = NEW.parent AND kind = 'GROUP'
  ) THEN
    RAISE EXCEPTION 'A menu entry can only be placed inside a group.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION totalbase.protect_admin_accounts() RETURNS trigger
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
    WHERE a."user" = actor AND r.admin_access AND r.active
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

CREATE FUNCTION totalbase.protect_workflows_role_assignment() RETURNS trigger
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
    RAISE EXCEPTION 'The Workflows role is reserved for TotalBase''s own system account and cannot be assigned to any other user.';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION totalbase.protect_workflows_role_assignment() IS 'Rejects assigning the reserved Workflows role to any user other than the seeded system account.';

CREATE FUNCTION totalbase.protect_workflows_user_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.email = 'workflows@system.totalbase.internal' THEN
    RAISE EXCEPTION 'The Workflows system user cannot be deleted.';
  END IF;
  RETURN OLD;
END;
$$;

COMMENT ON FUNCTION totalbase.protect_workflows_user_delete() IS 'Rejects deleting the seeded Workflows system user.';

CREATE FUNCTION totalbase.resource_column_presentation(p_resource uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  v_oid oid;
  v_type text;
  v_result jsonb;
BEGIN
  SELECT postgres_oid, type INTO v_oid, v_type FROM totalbase.resources WHERE id = p_resource;
  IF v_oid IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;

  WITH own AS (
    SELECT tc.name, tc.config FROM totalbase.resources_columns tc
    WHERE tc.resource = p_resource AND tc.config <> '{}'::jsonb
  ),
  inherited AS (
    SELECT a.attname::text AS name, totalbase.resource_column_presentation(source.id) -> sa.attname::text AS config
    FROM totalbase.view_column_origins(v_oid) o
    JOIN pg_catalog.pg_attribute a ON a.attrelid = v_oid AND a.attnum = o.attnum
    JOIN totalbase.resources source ON source.postgres_oid = o.origin_relid AND source.status = 'ACTIVE'
    JOIN pg_catalog.pg_attribute sa ON sa.attrelid = o.origin_relid AND sa.attnum = o.origin_attnum
    WHERE v_type = 'VIEW'
  ),
  merged AS (
    SELECT COALESCE(o.name, i.name) AS name, COALESCE(i.config, '{}'::jsonb) || COALESCE(o.config, '{}'::jsonb) AS config
    FROM own o
    FULL JOIN (SELECT * FROM inherited WHERE config IS NOT NULL) i ON i.name = o.name
  )
  SELECT COALESCE(jsonb_object_agg(name, config), '{}'::jsonb) INTO v_result FROM merged WHERE config <> '{}'::jsonb;
  RETURN v_result;
END
$$;

COMMENT ON FUNCTION totalbase.resource_column_presentation(p_resource uuid) IS 'A resource''s columns'' presentation by name: its own, over a view column''s origin column''s (view_column_origins).';

CREATE FUNCTION totalbase.roles_reserved_unchanged() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.reserved AND NULLIF(current_setting('totalbase.actor_user_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'The "%" role is reserved and cannot be modified or deleted.', OLD.name USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE FUNCTION totalbase.sessions_only_revocation() RETURNS trigger
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
  NEW.revoked_at := CASE
    WHEN OLD.revoked_at IS NOT NULL THEN OLD.revoked_at
    WHEN NEW.revoked_at IS NOT NULL THEN now()
    ELSE NULL
  END;
  RETURN NEW;
END;
$$;

CREATE FUNCTION totalbase.set_created_by() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := NULLIF(current_setting('totalbase.actor_user_id', true), '')::uuid;
  ELSE
    NEW.created_by := OLD.created_by;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION totalbase.set_uid() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE
  uid_column name;
  source_column name;
  row_values jsonb := to_jsonb(NEW);
  base text;
  candidate text;
  suffix int := 1;
  taken boolean;
BEGIN
  SELECT attname INTO uid_column FROM pg_attribute
   WHERE attrelid = TG_RELID AND attnum = TG_ARGV[0]::int2 AND NOT attisdropped;
  SELECT attname INTO source_column FROM pg_attribute
   WHERE attrelid = TG_RELID AND attnum = TG_ARGV[1]::int2 AND NOT attisdropped;
  IF uid_column IS NULL OR source_column IS NULL THEN
    RETURN NEW;
  END IF;
  IF coalesce(row_values ->> uid_column, '') <> '' THEN
    RETURN NEW;
  END IF;

  base := totalbase.slugify(row_values ->> source_column);
  IF base IS NULL THEN
    RETURN NEW;
  END IF;

  candidate := base;
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE %I = $1)', TG_TABLE_SCHEMA, TG_TABLE_NAME, uid_column)
      INTO taken USING candidate;
    EXIT WHEN NOT taken;
    suffix := suffix + 1;
    candidate := base || '-' || suffix;
  END LOOP;

  RETURN jsonb_populate_record(NEW, jsonb_build_object(uid_column, candidate));
END
$_$;

CREATE FUNCTION totalbase.set_updated_by() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_by := NULLIF(current_setting('totalbase.actor_user_id', true), '')::uuid;
  RETURN NEW;
END;
$$;

CREATE FUNCTION totalbase.slugify(value text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT nullif(
    trim(BOTH '-' FROM
      regexp_replace(
        regexp_replace(
          regexp_replace(
            lower(regexp_replace(normalize(value, NFD), '[̀-ͯ]', '', 'g')),
            '[\s_]+', '-', 'g'),
          '[^a-z0-9-]', '', 'g'),
        '-+', '-', 'g')),
    '')
$$;

CREATE FUNCTION totalbase.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE FUNCTION totalbase.users_keep_active() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.active AND NOT NEW.active THEN
    IF OLD.owner THEN
      RAISE EXCEPTION 'The instance owner cannot be deactivated.' USING ERRCODE = '42501';
    END IF;
    IF OLD.email = 'workflows@system.totalbase.internal' THEN
      RAISE EXCEPTION 'The Workflows system user cannot be deactivated.' USING ERRCODE = '42501';
    END IF;
    IF NULLIF(current_setting('totalbase.actor_user_id', true), '')::uuid = OLD.id THEN
      RAISE EXCEPTION 'You can''t deactivate your own account.' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION totalbase.users_keep_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.owner THEN
    RAISE EXCEPTION 'The instance owner cannot be deleted.' USING ERRCODE = '42501';
  END IF;
  IF NULLIF(current_setting('totalbase.actor_user_id', true), '')::uuid = OLD.id THEN
    RAISE EXCEPTION 'You can''t delete your own account.' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;

CREATE FUNCTION totalbase.users_revoke_sessions_on_deactivate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.active AND NOT NEW.active THEN
    UPDATE totalbase.sessions SET revoked_at = now()
    WHERE "user" = NEW.id AND revoked_at IS NULL;
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION totalbase.view_column_origins(p_view oid) RETURNS TABLE(attnum smallint, origin_relid oid, origin_attnum smallint)
    LANGUAGE sql STABLE
    AS $$
  SELECT DISTINCT ON (m.resno) m.resno, m.relid, m.col
  FROM pg_catalog.pg_rewrite r
  CROSS JOIN LATERAL regexp_matches(
    r.ev_action::text,
    ':resno (\d+) :resname (\S+) :ressortgroupref \d+ :resorigtbl (\d+) :resorigcol (\d+) :resjunk false',
    'g'
  ) WITH ORDINALITY AS t(g, n)
  CROSS JOIN LATERAL (SELECT t.g[1]::int2 AS resno, t.g[2] AS resname, t.g[3]::oid AS relid, t.g[4]::int2 AS col) m
  JOIN pg_catalog.pg_attribute a ON a.attrelid = p_view AND a.attnum = m.resno AND a.attname::text = m.resname
  WHERE r.ev_class = p_view AND r.rulename = '_RETURN' AND m.relid <> 0
  ORDER BY m.resno, t.n DESC
$$;

COMMENT ON FUNCTION totalbase.view_column_origins(p_view oid) IS 'Which table column each column of a view is, as PostgreSQL recorded it in the view''s query (resorigtbl/resorigcol); expressions have none.';

CREATE TABLE totalbase.roles_reviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    role uuid NOT NULL,
    reviewer uuid,
    members jsonb DEFAULT '[]'::jsonb NOT NULL,
    outcome text NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT roles_reviews_note_check CHECK ((length(note) <= 1000)),
    CONSTRAINT roles_reviews_outcome_check CHECK ((outcome = ANY (ARRAY['NO_CHANGES'::text, 'CHANGES_MADE'::text])))
);

COMMENT ON COLUMN totalbase.roles_reviews.members IS 'The role''s members when it was reviewed: [{ id, email, name }], filled in by the trigger.';

CREATE TABLE totalbase.tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "user" uuid NOT NULL,
    name text NOT NULL,
    description text,
    plane text DEFAULT 'API'::text NOT NULL,
    key_prefix text NOT NULL,
    key_hash text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    expires_at timestamp with time zone,
    last_used_at timestamp with time zone,
    rotated_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    previous_key_hash text,
    previous_expires_at timestamp with time zone,
    CONSTRAINT tokens_description_length CHECK (((description IS NULL) OR (length(description) <= 128))),
    CONSTRAINT tokens_name_length CHECK ((length(name) <= 32)),
    CONSTRAINT tokens_plane_check CHECK ((plane = ANY (ARRAY['API'::text, 'ADMIN'::text]))),
    CONSTRAINT tokens_previous_key_check CHECK (((previous_key_hash IS NULL) = (previous_expires_at IS NULL)))
);

COMMENT ON COLUMN totalbase.tokens.previous_key_hash IS 'The secret replaced by the last regeneration, still valid until previous_expires_at. Never readable.';

COMMENT ON COLUMN totalbase.tokens.previous_expires_at IS 'Until when previous_key_hash still authenticates - the regeneration''s grace window.';

CREATE TABLE totalbase.users_roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "user" uuid NOT NULL,
    role uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE totalbase.audits_exclusions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    resource uuid NOT NULL,
    column_attnum smallint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT audits_exclusions_column_attnum_check CHECK ((column_attnum > 0))
);

CREATE TABLE totalbase.roles_capabilities (
    role uuid NOT NULL,
    effect text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    capability text NOT NULL,
    CONSTRAINT roles_capabilities_capability_check CHECK ((capability = ANY (ARRAY['TRANSACTIONS'::text, 'SEND_EMAIL'::text]))),
    CONSTRAINT roles_capabilities_effect_check CHECK ((effect = ANY (ARRAY['ALLOW'::text, 'DENY'::text])))
);

CREATE TABLE totalbase.invalidations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    topic text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE totalbase.resources_columns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    resource uuid NOT NULL,
    attnum integer NOT NULL,
    name text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE totalbase.dashboards (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    description text,
    icon text,
    color text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    variables jsonb DEFAULT '[]'::jsonb NOT NULL,
    scope text DEFAULT 'LISTED'::text NOT NULL,
    refresh_interval_seconds integer,
    embedding_enabled boolean DEFAULT false NOT NULL,
    menu_label text,
    tabs jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT dashboards_color_allowed CHECK (((color IS NULL) OR (color = ANY (ARRAY['red'::text, 'orange'::text, 'amber'::text, 'yellow'::text, 'lime'::text, 'green'::text, 'emerald'::text, 'teal'::text, 'cyan'::text, 'sky'::text, 'blue'::text, 'indigo'::text, 'violet'::text, 'purple'::text, 'fuchsia'::text, 'pink'::text, 'rose'::text])))),
    CONSTRAINT dashboards_description_length CHECK (((description IS NULL) OR (length(description) <= 128))),
    CONSTRAINT dashboards_name_valid CHECK (totalbase.is_valid_name(name)),
    CONSTRAINT dashboards_slug_length CHECK ((length(slug) <= 32)),
    CONSTRAINT dashboards_tabs_is_array CHECK ((jsonb_typeof(tabs) = 'array'::text)),
    CONSTRAINT dashboards_variables_array CHECK ((jsonb_typeof(variables) = 'array'::text)),
    CONSTRAINT dashboards_menu_label_check CHECK ((length(menu_label) <= 32)),
    CONSTRAINT dashboards_refresh_interval_seconds_check CHECK ((refresh_interval_seconds = ANY (ARRAY[30, 60, 300, 900, 3600]))),
    CONSTRAINT dashboards_scope_check CHECK ((scope = ANY (ARRAY['LISTED'::text, 'EMBEDDED_ONLY'::text])))
);

COMMENT ON COLUMN totalbase.dashboards.variables IS 'Draft variable definitions ($VAR.*) - [{name, label, type, ...}]. Validated by @totalbase/dashboards.';

COMMENT ON COLUMN totalbase.dashboards.scope IS 'LISTED: shown in the App menu and list. EMBEDDED_ONLY: only mounted inside a DataView form.';

COMMENT ON COLUMN totalbase.dashboards.refresh_interval_seconds IS 'Auto-refresh interval of the App''s viewer, in seconds: 30, 60, 300, 900 or 3600; NULL = off.';

COMMENT ON COLUMN totalbase.dashboards.embedding_enabled IS 'Whether a signed embed token may show its published version outside TotalBase. Off by default.';

COMMENT ON COLUMN totalbase.dashboards.tabs IS 'Its tabs (D7): [{value, label, icon?}] in order - empty: one grid. A widget''s `tab` is one of their values.';

CREATE TABLE totalbase.dashboards_embeds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    dashboard uuid NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    display jsonb DEFAULT '{}'::jsonb NOT NULL,
    variables jsonb DEFAULT '{}'::jsonb NOT NULL,
    origins text[] DEFAULT '{}'::text[] NOT NULL,
    link_hash text,
    link_ciphertext text,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    last_used_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dashboards_embeds_check CHECK (((type = 'LINK'::text) = ((link_hash IS NOT NULL) AND (link_ciphertext IS NOT NULL)))),
    CONSTRAINT dashboards_embeds_name_check CHECK (((length(name) >= 1) AND (length(name) <= 32))),
    CONSTRAINT dashboards_embeds_type_check CHECK ((type = ANY (ARRAY['LINK'::text, 'SIGNED'::text])))
);

COMMENT ON COLUMN totalbase.dashboards_embeds.display IS '{ theme, titled, transparent, refreshSeconds } - how it looks.';

COMMENT ON COLUMN totalbase.dashboards_embeds.variables IS '{ <name>: { mode: EDITABLE | HIDDEN | LOCKED, value? } } - a LOCKED variable with no value takes it from a SIGNED token; a published variable not listed is EDITABLE.';

COMMENT ON COLUMN totalbase.dashboards_embeds.origins IS 'Sites that may frame it - within dashboards.embed_allowed_origins; empty = all of those.';

COMMENT ON COLUMN totalbase.dashboards_embeds.link_hash IS 'LINK only: sha256 of the link''s secret, how a request finds it.';

COMMENT ON COLUMN totalbase.dashboards_embeds.link_ciphertext IS 'LINK only: the secret encrypted with the master key, so an administrator can copy the link again.';

CREATE TABLE totalbase.dashboards_roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    dashboard uuid NOT NULL,
    role uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE totalbase.dashboards_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    dashboard uuid NOT NULL,
    version integer NOT NULL,
    restored_from_version integer,
    widgets_snapshot jsonb NOT NULL,
    "user" uuid,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    variables_snapshot jsonb DEFAULT '[]'::jsonb NOT NULL,
    tabs_snapshot jsonb DEFAULT '[]'::jsonb NOT NULL,
    note text,
    CONSTRAINT dashboards_versions_version_positive CHECK ((version > 0)),
    CONSTRAINT dashboards_versions_note_check CHECK ((length(note) <= 128))
);

CREATE TABLE totalbase.dashboards_widgets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    dashboard uuid NOT NULL,
    label text,
    grid_x integer NOT NULL,
    grid_y integer NOT NULL,
    grid_w integer NOT NULL,
    grid_h integer NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    type text NOT NULL,
    query text,
    tab text,
    CONSTRAINT dashboards_widgets_config_object CHECK ((jsonb_typeof(config) = 'object'::text)),
    CONSTRAINT dashboards_widgets_type_allowed CHECK ((type = ANY (ARRAY['KPI'::text, 'GAUGE'::text, 'PROGRESS'::text, 'BAR'::text, 'BAR_HORIZONTAL'::text, 'COMBO'::text, 'WATERFALL'::text, 'LEADERBOARD'::text, 'LINE'::text, 'AREA'::text, 'PIE'::text, 'DONUT'::text, 'FUNNEL'::text, 'TREEMAP'::text, 'SUNBURST'::text, 'HEATMAP'::text, 'CALENDAR'::text, 'SCATTER'::text, 'MAP'::text, 'TABLE'::text, 'DETAIL'::text, 'PIVOT'::text, 'TImage'::text, 'THeading'::text, 'TText'::text, 'TQrCode'::text, 'UBadge'::text, 'UAlert'::text, 'USeparator'::text, 'TFrame'::text])))
);

COMMENT ON COLUMN totalbase.dashboards_widgets.config IS 'Its type''s config (the dashboard widget catalog, @totalbase/canvas): a data widget''s roles and props; a presentation widget''s page props and formulas (props, bindings).';

COMMENT ON COLUMN totalbase.dashboards_widgets.query IS 'Admin-authored SQL, executed read-only (READ ONLY transaction + statement_timeout + row cap). NULL = not configured yet - a data widget then draws nothing; a presentation widget draws without rows.';

COMMENT ON COLUMN totalbase.dashboards_widgets.tab IS 'The tab it is on (a value of its dashboard''s tabs) - NULL: the first.';

CREATE TABLE totalbase.dataviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    description text,
    icon text,
    color text,
    source_resource uuid,
    view_type text NOT NULL,
    scope text DEFAULT 'LISTED'::text NOT NULL,
    view_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    code text DEFAULT ''::text NOT NULL,
    owner uuid,
    menu_label text,
    CONSTRAINT dataviews_color_allowed CHECK (((color IS NULL) OR (color = ANY (ARRAY['red'::text, 'orange'::text, 'amber'::text, 'yellow'::text, 'lime'::text, 'green'::text, 'emerald'::text, 'teal'::text, 'cyan'::text, 'sky'::text, 'blue'::text, 'indigo'::text, 'violet'::text, 'purple'::text, 'fuchsia'::text, 'pink'::text, 'rose'::text])))),
    CONSTRAINT dataviews_description_length CHECK (((description IS NULL) OR (length(description) <= 128))),
    CONSTRAINT dataviews_name_valid CHECK (totalbase.is_valid_name(name)),
    CONSTRAINT dataviews_slug_length CHECK ((length(slug) <= 32)),
    CONSTRAINT dataviews_source_required CHECK (((view_type = 'CUSTOM'::text) OR ((view_type = 'EXTERNALFRAME'::text) AND (source_resource IS NULL)) OR ((view_type <> 'EXTERNALFRAME'::text) AND (source_resource IS NOT NULL)))),
    CONSTRAINT dataviews_menu_label_check CHECK ((length(menu_label) <= 32)),
    CONSTRAINT dataviews_owner_not_self CHECK ((owner <> id)),
    CONSTRAINT dataviews_scope_check CHECK ((scope = ANY (ARRAY['LISTED'::text, 'EMBEDDED_ONLY'::text]))),
    CONSTRAINT dataviews_view_type_check CHECK ((view_type = ANY (ARRAY['TABLE'::text, 'FORM'::text, 'CARDS'::text, 'MAP'::text, 'KANBAN'::text, 'CALENDAR'::text, 'GANTT'::text, 'TREE'::text, 'EXTERNALFRAME'::text, 'MASTER_DETAIL'::text, 'CUSTOM'::text, 'SETTINGS'::text])))
);

COMMENT ON COLUMN totalbase.dataviews.code IS 'Draft client-side controller code, edited in Studio; not visible to consumers until published (see dataviews_publishes).';

CREATE TABLE totalbase.dataviews_roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    dataview uuid NOT NULL,
    role uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE totalbase.dataviews_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    dataview uuid NOT NULL,
    version integer NOT NULL,
    restored_from_version integer,
    view_config_snapshot jsonb NOT NULL,
    fields_snapshot jsonb NOT NULL,
    code_snapshot text DEFAULT ''::text NOT NULL,
    "user" uuid,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    presentation_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    note text,
    CONSTRAINT dataviews_versions_version_positive CHECK ((version > 0)),
    CONSTRAINT dataviews_versions_note_check CHECK ((length(note) <= 128))
);

CREATE TABLE totalbase.executions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type text NOT NULL,
    resource uuid,
    status text DEFAULT 'PENDING'::text NOT NULL,
    principal_type text NOT NULL,
    principal uuid NOT NULL,
    request jsonb,
    result jsonb,
    error jsonb,
    attempt integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    locked_at timestamp with time zone,
    locked_by text,
    cancel_requested_at timestamp with time zone,
    CONSTRAINT executions_principal_type_check CHECK ((principal_type = ANY (ARRAY['USER'::text, 'API_KEY'::text]))),
    CONSTRAINT executions_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'RUNNING'::text, 'COMPLETED'::text, 'FAILED'::text, 'CANCELLED'::text])))
);

COMMENT ON COLUMN totalbase.executions.resource IS 'The object the execution acts on, interpreted by its `type` - not a foreign key, since each type names a different kind of object.';

COMMENT ON COLUMN totalbase.executions.available_at IS 'A worker claims only rows with available_at <= now() - the retry backoff.';

COMMENT ON COLUMN totalbase.executions.started_at IS 'Set when a worker claims the row; a RUNNING row whose lock went stale is reclaimed.';

COMMENT ON COLUMN totalbase.executions.cancel_requested_at IS 'When its caller asked to cancel it (POST /api/executions/{id}/cancel). A running function call or transaction checks it right before COMMIT; one that committed first stays COMPLETED.';

CREATE TABLE totalbase.dataviews_fields (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    dataview uuid NOT NULL,
    kind text NOT NULL,
    grid_x integer NOT NULL,
    grid_y integer NOT NULL,
    grid_w integer NOT NULL,
    grid_h integer NOT NULL,
    label text,
    icon text,
    column_attnum integer,
    column_name text,
    widget text,
    visible boolean DEFAULT true NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    related_dataview uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    parent uuid,
    relation_attnum integer,
    target_attnum integer,
    related_dashboard uuid,
    CONSTRAINT dataviews_fields_kind_check CHECK ((kind = ANY (ARRAY['COLUMN'::text, 'RELATED'::text, 'WIDGET'::text]))),
    CONSTRAINT dataviews_fields_shape CHECK ((((kind = 'COLUMN'::text) AND (column_attnum IS NOT NULL) AND (widget IS NOT NULL) AND (parent IS NULL) AND (relation_attnum IS NULL) AND (target_attnum IS NULL)) OR ((kind = 'RELATED'::text) AND (relation_attnum IS NOT NULL) AND (target_attnum IS NOT NULL) AND (column_name IS NOT NULL) AND (widget IS NOT NULL) AND (column_attnum IS NULL) AND (parent IS NULL)) OR ((kind = 'WIDGET'::text) AND (widget IS NOT NULL) AND (column_attnum IS NULL) AND (relation_attnum IS NULL) AND (target_attnum IS NULL))))
);

CREATE TABLE totalbase.files (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    folder uuid,
    name text NOT NULL,
    extension text DEFAULT ''::text NOT NULL,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL,
    storage_provider text NOT NULL,
    storage_key text NOT NULL,
    checksum text,
    visibility text DEFAULT 'PRIVATE'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    description text,
    tags text[] DEFAULT ARRAY[]::text[] NOT NULL,
    created_by uuid,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    width integer,
    height integer,
    CONSTRAINT files_name_check CHECK ((length(name) > 0)),
    CONSTRAINT files_name_check1 CHECK ((length(name) <= 255)),
    CONSTRAINT files_size_bytes_check CHECK ((size_bytes >= 0)),
    CONSTRAINT files_visibility_check CHECK ((visibility = ANY (ARRAY['PRIVATE'::text, 'PUBLIC'::text])))
);

COMMENT ON COLUMN totalbase.files.width IS 'Image width in pixels, captured at upload time. NULL for non-image files.';

COMMENT ON COLUMN totalbase.files.height IS 'Image height in pixels, captured at upload time. NULL for non-image files.';

COMMENT ON CONSTRAINT files_name_check ON totalbase.files IS 'A file needs a name.';

COMMENT ON CONSTRAINT files_name_check1 ON totalbase.files IS 'A file name can be at most 255 characters.';

CREATE TABLE totalbase.folders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    parent uuid,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT folders_name_valid CHECK (totalbase.is_valid_name(name)),
    CONSTRAINT folders_name_check CHECK ((length(name) > 0)),
    CONSTRAINT folders_name_check1 CHECK ((length(name) <= 32)),
    CONSTRAINT folders_name_check2 CHECK ((POSITION(('/'::text) IN (name)) = 0)),
    CONSTRAINT folders_name_check3 CHECK ((POSITION((chr(92)) IN (name)) = 0))
);

COMMENT ON CONSTRAINT folders_name_valid ON totalbase.folders IS 'A name is 1 to 32 characters - letters, digits, spaces and - _ . , : ; ( ) '' & + only.';

CREATE TABLE totalbase.idempotency_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    principal_type text NOT NULL,
    principal uuid NOT NULL,
    operation_scope text NOT NULL,
    request_hash text NOT NULL,
    status text DEFAULT 'IN_PROGRESS'::text NOT NULL,
    response_status integer,
    response_body jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    response_truncated boolean DEFAULT false NOT NULL,
    CONSTRAINT idempotency_keys_principal_type_check CHECK ((principal_type = ANY (ARRAY['USER'::text, 'API_KEY'::text]))),
    CONSTRAINT idempotency_keys_status_check CHECK ((status = ANY (ARRAY['IN_PROGRESS'::text, 'DONE'::text])))
);

COMMENT ON COLUMN totalbase.idempotency_keys.operation_scope IS 'Identifies the specific operation, e.g. "table:public.invoices:create" or "external_endpoint:generate-invoice-pdf" - not the full URL.';

COMMENT ON COLUMN totalbase.idempotency_keys.request_hash IS 'SHA-256 of method, operation scope and the JSON body as sent; the same key with a different hash is IDEMPOTENCY_KEY_REUSED.';

COMMENT ON COLUMN totalbase.idempotency_keys.status IS 'IN_PROGRESS while the first request is still executing; DONE once the response has been recorded. A concurrent request seeing IN_PROGRESS gets 409 idempotency_request_in_progress.';

COMMENT ON COLUMN totalbase.idempotency_keys.response_truncated IS 'true when the original response exceeded idempotency.max_response_bytes and response_body was not stored - a retry with this key gets IDEMPOTENCY_RESPONSE_TOO_LARGE_TO_REPLAY instead of a replayed body. The underlying operation still only executed once.';

CREATE TABLE totalbase.identities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "user" uuid NOT NULL,
    provider uuid NOT NULL,
    provider_subject text NOT NULL,
    provider_email text,
    provider_username text,
    provider_avatar_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_login_at timestamp with time zone
);

CREATE TABLE totalbase.instance (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE totalbase.logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    request_id uuid NOT NULL,
    principal_type text NOT NULL,
    principal uuid,
    session uuid,
    resource uuid,
    action text NOT NULL,
    status text NOT NULL,
    source text NOT NULL,
    ip inet,
    user_agent text,
    fields jsonb,
    where_clause jsonb,
    payload jsonb,
    changes jsonb,
    metadata jsonb,
    sql_text text,
    sql_params jsonb,
    error_code text,
    sqlstate text,
    error_message text,
    error_detail text,
    error_hint text,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone,
    duration_ms integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    event text GENERATED ALWAYS AS ((metadata ->> 'event'::text)) STORED,
    workflow_run uuid GENERATED ALWAYS AS (((metadata ->> 'workflowRun'::text))::uuid) STORED,
    CONSTRAINT logs_principal_type_check CHECK ((principal_type = ANY (ARRAY['USER'::text, 'API_KEY'::text, 'ADMIN'::text, 'SYSTEM'::text]))),
    CONSTRAINT logs_status_check CHECK ((status = ANY (ARRAY['DENIED'::text, 'EXECUTED'::text, 'FAILED'::text])))
);

CREATE TABLE totalbase.menus (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    parent uuid,
    kind text NOT NULL,
    dataview uuid,
    dashboard uuid,
    name text,
    icon text,
    "position" integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    icon_open text,
    open_state text DEFAULT 'DEFAULT'::text NOT NULL,
    CONSTRAINT menus_kind_shape CHECK ((((kind = 'GROUP'::text) AND (dataview IS NULL) AND (dashboard IS NULL) AND (name IS NOT NULL) AND (length(btrim(name)) > 0)) OR ((kind = 'DATAVIEW'::text) AND (dataview IS NOT NULL) AND (dashboard IS NULL) AND (name IS NULL) AND (icon IS NULL) AND (icon_open IS NULL)) OR ((kind = 'DASHBOARD'::text) AND (dashboard IS NOT NULL) AND (dataview IS NULL) AND (name IS NULL) AND (icon IS NULL) AND (icon_open IS NULL)))),
    CONSTRAINT menus_kind_check CHECK ((kind = ANY (ARRAY['GROUP'::text, 'DATAVIEW'::text, 'DASHBOARD'::text]))),
    CONSTRAINT menus_name_check CHECK ((length(name) <= 32)),
    CONSTRAINT menus_open_state_check CHECK ((open_state = ANY (ARRAY['DEFAULT'::text, 'OPEN'::text, 'CLOSED'::text])))
);

COMMENT ON COLUMN totalbase.menus.open_state IS 'A GROUP''s initial state in the tree menu: DEFAULT (the menu setting app.menu_groups_open), OPEN or CLOSED.';

CREATE TABLE totalbase.outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    request_id uuid NOT NULL,
    resource uuid NOT NULL,
    event text NOT NULL,
    payload jsonb NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    locked_at timestamp with time zone,
    locked_by text,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    locked_until timestamp with time zone,
    old_payload jsonb,
    changed_columns text[],
    source text DEFAULT 'api'::text NOT NULL,
    workflow_ancestry uuid[],
    CONSTRAINT outbox_event_check CHECK ((event = ANY (ARRAY['CREATE'::text, 'UPDATE'::text, 'DELETE'::text, 'EXECUTE'::text]))),
    CONSTRAINT outbox_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'PROCESSING'::text, 'PROCESSED'::text, 'FAILED'::text])))
);

COMMENT ON COLUMN totalbase.outbox.locked_until IS 'End of the dispatcher''s lease on a PROCESSING event; past it the event counts as an abandoned (failed) attempt.';

COMMENT ON COLUMN totalbase.outbox.old_payload IS 'UPDATE only: the row before the write. Used to match, never passed to a run.';

COMMENT ON COLUMN totalbase.outbox.changed_columns IS 'UPDATE only: the columns whose value the write changed.';

COMMENT ON COLUMN totalbase.outbox.source IS 'Where the write came from (the audit log''s source): api, admin, workflow... - the dispatcher reads it here, never from the audit log.';

COMMENT ON COLUMN totalbase.outbox.workflow_ancestry IS 'A workflow''s write: the workflow ids that led to it, outermost first (loop and depth protection). NULL on a workflow write whose step opted out of emitting events.';

CREATE TABLE totalbase.outbox_admissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event uuid NOT NULL,
    workflow uuid NOT NULL,
    item integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT outbox_admissions_item_check CHECK ((item >= 0))
);

COMMENT ON COLUMN totalbase.outbox_admissions.item IS 'Position of the record in the outbox event payload; NULL for a suppression that applies to the workflow as a whole.';

CREATE TABLE totalbase.permissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    role uuid NOT NULL,
    resource uuid NOT NULL,
    action text NOT NULL,
    effect text NOT NULL,
    where_clause jsonb,
    field_overrides jsonb DEFAULT '[]'::jsonb NOT NULL,
    payload_checks jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT permissions_action_check CHECK ((action = ANY (ARRAY['CREATE'::text, 'READ'::text, 'UPDATE'::text, 'DELETE'::text, 'EXECUTE'::text]))),
    CONSTRAINT permissions_effect_check CHECK ((effect = ANY (ARRAY['ALLOW'::text, 'DENY'::text])))
);

CREATE TABLE totalbase.providers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type text NOT NULL,
    name text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    configuration jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    slug text NOT NULL,
    show_on_sign_in boolean DEFAULT false NOT NULL,
    CONSTRAINT providers_name_valid CHECK (totalbase.is_valid_name(name)),
    CONSTRAINT providers_slug_check CHECK ((slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'::text)),
    CONSTRAINT providers_type_check CHECK ((type = ANY (ARRAY['GOOGLE'::text, 'GITHUB'::text, 'OIDC'::text])))
);

COMMENT ON COLUMN totalbase.providers.slug IS 'The provider''s route segment (/api/auth/oauth/{slug}): google, github, or an OIDC provider''s name slugified. UNIQUE.';

COMMENT ON COLUMN totalbase.providers.show_on_sign_in IS 'Its button on the portal''s sign-in page; the portal flow (redirect_to = the portal''s own callback) is refused while off.';

CREATE TABLE totalbase.sql_queries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    admin uuid NOT NULL,
    sql_text text NOT NULL,
    status text NOT NULL,
    duration_ms integer,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sql_queries_status_check CHECK ((status = ANY (ARRAY['EXECUTED'::text, 'FAILED'::text])))
);

CREATE TABLE totalbase.resources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    postgres_oid oid NOT NULL,
    schema text NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    status text NOT NULL,
    function_class text,
    audit_read boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    exposed_methods text[] DEFAULT '{}'::text[] NOT NULL,
    description text,
    require_idempotency_key boolean DEFAULT false NOT NULL,
    row_presentation jsonb DEFAULT '{}'::jsonb NOT NULL,
    default_sort jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT resources_function_class_check CHECK ((function_class = ANY (ARRAY['UNCLASSIFIED'::text, 'QUERY'::text, 'ACTION'::text]))),
    CONSTRAINT resources_require_idempotency_key_check CHECK (((NOT require_idempotency_key) OR (type = ANY (ARRAY['TABLE'::text, 'FUNCTION'::text])))),
    CONSTRAINT resources_row_presentation_check CHECK ((jsonb_typeof(row_presentation) = 'object'::text)),
    CONSTRAINT resources_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'MISSING'::text]))),
    CONSTRAINT resources_type_check CHECK ((type = ANY (ARRAY['TABLE'::text, 'VIEW'::text, 'FUNCTION'::text])))
);

COMMENT ON COLUMN totalbase.resources.exposed_methods IS 'HTTP verbs mounted for this resource in the Data API, subset of {GET,POST,PATCH,DELETE}. Only takes effect when exposed = true.';

COMMENT ON COLUMN totalbase.resources.description IS 'User-facing description of this resource, set by TotalBase - not a PostgreSQL COMMENT ON.';

COMMENT ON COLUMN totalbase.resources.require_idempotency_key IS 'A TABLE''s CREATE or a FUNCTION''s EXECUTE answers 400 IDEMPOTENCY_KEY_REQUIRED without an Idempotency-Key header.';

COMMENT ON COLUMN totalbase.resources.row_presentation IS 'How a row of this table shows where a foreign key points at it: {displayField, displayTemplate}. Inherited by foreign-key columns.';

COMMENT ON CONSTRAINT resources_require_idempotency_key_check ON totalbase.resources IS 'Only a table or a function can require an idempotency key.';

CREATE TABLE totalbase.roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    reserved boolean DEFAULT false NOT NULL,
    description text,
    icon text,
    color text,
    admin_access boolean DEFAULT false NOT NULL,
    app_access boolean DEFAULT true NOT NULL,
    api_access boolean DEFAULT false NOT NULL,
    created_by uuid,
    home_dataview uuid,
    home_dashboard uuid,
    CONSTRAINT roles_color_allowed CHECK (((color IS NULL) OR (color = ANY (ARRAY['red'::text, 'orange'::text, 'amber'::text, 'yellow'::text, 'lime'::text, 'green'::text, 'emerald'::text, 'teal'::text, 'cyan'::text, 'sky'::text, 'blue'::text, 'indigo'::text, 'violet'::text, 'purple'::text, 'fuchsia'::text, 'pink'::text, 'rose'::text])))),
    CONSTRAINT roles_description_length CHECK (((description IS NULL) OR (length(description) <= 128))),
    CONSTRAINT roles_home_one CHECK ((num_nonnulls(home_dataview, home_dashboard) <= 1)),
    CONSTRAINT roles_icon_valid CHECK (((icon IS NULL) OR ((length(icon) <= 64) AND (icon ~ '^i-lucide-[a-z0-9]+(-[a-z0-9]+)*$'::text)))),
    CONSTRAINT roles_name_valid CHECK (((name = btrim(name)) AND ((length(name) >= 1) AND (length(name) <= 64)))),
    CONSTRAINT roles_admin_access_reserved_check CHECK (((NOT admin_access) OR reserved))
);

COMMENT ON COLUMN totalbase.roles.admin_access IS 'Admin portal + full permissions bypass. Reserved roles only (CHECK). Effective access = OR across a user''s active roles.';

COMMENT ON COLUMN totalbase.roles.app_access IS 'May log into the portal in app mode. Effective access = OR across a user''s active roles.';

COMMENT ON COLUMN totalbase.roles.api_access IS 'May authenticate programmatically (POST /api/auth/login, data-plane OAuth, plane=api tokens). Effective access = OR across a user''s active roles.';

COMMENT ON COLUMN totalbase.roles.home_dataview IS 'The DataView its members open the App on - grants nothing.';

COMMENT ON COLUMN totalbase.roles.home_dashboard IS 'The Dashboard its members open the App on - grants nothing.';

COMMENT ON CONSTRAINT roles_icon_valid ON totalbase.roles IS 'Unknown role icon.';

COMMENT ON CONSTRAINT roles_name_valid ON totalbase.roles IS 'A role''s name is 1 to 64 characters, without leading or trailing spaces.';

CREATE TABLE totalbase.roles_managers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    role uuid NOT NULL,
    manager uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT roles_managers_check CHECK ((role <> manager))
);

CREATE TABLE totalbase.secrets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    ciphertext text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE totalbase.sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "user" uuid NOT NULL,
    token_hash text NOT NULL,
    ip inet,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone
);

CREATE TABLE totalbase.settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    value jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE totalbase.dataviews_shares (
    state uuid NOT NULL,
    "user" uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    role uuid,
    CONSTRAINT dataviews_shares_recipient_check CHECK ((num_nonnulls("user", role) = 1))
);

CREATE TABLE totalbase.dataviews_states (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    dataview uuid NOT NULL,
    "user" uuid NOT NULL,
    name text,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dataviews_states_name_length CHECK (((name IS NULL) OR (length(name) <= 32)))
);

CREATE TABLE totalbase.templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    slug text NOT NULL,
    kind text NOT NULL,
    content jsonb NOT NULL,
    default_cc text[],
    default_bcc text[],
    default_reply_to text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT templates_content_is_object CHECK ((jsonb_typeof(content) = 'object'::text)),
    CONSTRAINT templates_description_length CHECK (((description IS NULL) OR (length(description) <= 128))),
    CONSTRAINT templates_mailing_content_shape CHECK (((kind <> 'MAILING'::text) OR ((content ? 'subject'::text) AND (content ? 'message'::text)))),
    CONSTRAINT templates_name_length CHECK ((length(name) <= 32)),
    CONSTRAINT templates_name_valid CHECK (totalbase.is_valid_name(name)),
    CONSTRAINT templates_slug_length CHECK ((length(slug) <= 32)),
    CONSTRAINT templates_slug_valid CHECK ((slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text)),
    CONSTRAINT templates_kind_check CHECK ((kind = ANY (ARRAY['MAILING'::text, 'PDF'::text])))
);

COMMENT ON COLUMN totalbase.templates.content IS 'Engine-specific payload: {"subject","message"} for MAILING; a pdfme template JSON for PDF.';

COMMENT ON COLUMN totalbase.templates.default_cc IS 'Send-time defaults, only meaningful for kind=MAILING - NULL for PDF.';

COMMENT ON CONSTRAINT templates_name_valid ON totalbase.templates IS 'A name is 1 to 32 characters - letters, digits, spaces and - _ . , : ; ( ) '' & + only.';

COMMENT ON CONSTRAINT templates_slug_valid ON totalbase.templates IS 'A slug is lowercase letters, digits and single hyphens, starting and ending with a letter or digit.';

CREATE TABLE totalbase.emails_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "user" uuid NOT NULL,
    type text NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT emails_tokens_type_check CHECK ((type = ANY (ARRAY['INVITATION'::text, 'PASSWORD_RESET'::text, 'EMAIL_VERIFICATION'::text])))
);

CREATE TABLE totalbase.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    password_hash text,
    name text,
    avatar_url text,
    active boolean DEFAULT true NOT NULL,
    email_verified_at timestamp with time zone,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    owner boolean DEFAULT false NOT NULL,
    can_login boolean DEFAULT true NOT NULL,
    failed_login_count integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    preferences jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT users_email_not_blank CHECK ((btrim(email) <> ''::text)),
    CONSTRAINT users_email_valid CHECK (((email = btrim(email)) AND (length(email) <= 254) AND (email ~ '^[^[:space:]@]+@[^[:space:]@]+$'::text))),
    CONSTRAINT users_name_valid CHECK (((name IS NULL) OR ((name = btrim(name)) AND ((length(name) >= 1) AND (length(name) <= 200))))),
    CONSTRAINT users_preferences_language_valid CHECK (((NOT (preferences ? 'language'::text)) OR ((jsonb_typeof((preferences -> 'language'::text)) = 'string'::text) AND ((preferences ->> 'language'::text) ~ '^[a-z]{2}(-[A-Z]{2})?$'::text)))),
    CONSTRAINT users_preferences_valid CHECK (((jsonb_typeof(preferences) = 'object'::text) AND ((NOT (preferences ? 'timezone'::text)) OR ((jsonb_typeof((preferences -> 'timezone'::text)) = 'string'::text) AND ((length((preferences ->> 'timezone'::text)) >= 1) AND (length((preferences ->> 'timezone'::text)) <= 64)))) AND ((NOT (preferences ? 'date_format'::text)) OR ((preferences ->> 'date_format'::text) = ANY (ARRAY['dd/MM/yyyy'::text, 'MM/dd/yyyy'::text, 'yyyy-MM-dd'::text, 'dd.MM.yyyy'::text, 'd MMM yyyy'::text]))) AND ((NOT (preferences ? 'time_format'::text)) OR ((preferences ->> 'time_format'::text) = ANY (ARRAY['HH:mm'::text, 'h:mm a'::text])))))
);

COMMENT ON COLUMN totalbase.users.failed_login_count IS 'Consecutive failed sign-ins since the last success/unlock. Reset to 0 when it triggers a lockout.';

COMMENT ON COLUMN totalbase.users.locked_until IS 'Sign-in is refused until this instant (account lockout). NULL = not locked.';

COMMENT ON COLUMN totalbase.users.preferences IS 'The user''s own display preferences (timezone, date_format, time_format). A missing key = the instance default (system.* settings).';

COMMENT ON CONSTRAINT users_email_valid ON totalbase.users IS 'Enter a valid email address.';

COMMENT ON CONSTRAINT users_name_valid ON totalbase.users IS 'A user''s name is 1 to 200 characters, without leading or trailing spaces.';

CREATE TABLE totalbase.workflows (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    slug text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    definition jsonb NOT NULL,
    history_enabled boolean DEFAULT true NOT NULL,
    history_level text DEFAULT 'SUMMARY'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    CONSTRAINT workflows_definition_object CHECK ((jsonb_typeof(definition) = 'object'::text)),
    CONSTRAINT workflows_history_level_check CHECK ((history_level = ANY (ARRAY['SUMMARY'::text, 'DETAILED'::text]))),
    CONSTRAINT workflows_revision_check CHECK ((revision > 0)),
    CONSTRAINT workflows_description_length CHECK (((description IS NULL) OR (length(description) <= 128))),
    CONSTRAINT workflows_name_valid CHECK (totalbase.is_valid_name(name)),
    CONSTRAINT workflows_slug_length CHECK ((length(slug) <= 32))
);

COMMENT ON COLUMN totalbase.workflows.definition IS 'The DRAFT definition (what the editor edits). Published versions live in workflows_versions.';

CREATE TABLE totalbase.workflows_crons (
    workflow uuid NOT NULL,
    scheduled_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL
);

CREATE TABLE totalbase.workflows_roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    role uuid NOT NULL,
    workflow uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE totalbase.workflows_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workflow uuid NOT NULL,
    version uuid,
    trigger text NOT NULL,
    mode text NOT NULL,
    status text NOT NULL,
    initiator jsonb,
    executor jsonb NOT NULL,
    lease jsonb,
    result jsonb,
    error jsonb,
    history_enabled boolean NOT NULL,
    history_level text NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    has_handled_errors boolean DEFAULT false NOT NULL,
    CONSTRAINT workflows_runs_history_level_check CHECK ((history_level = ANY (ARRAY['SUMMARY'::text, 'DETAILED'::text]))),
    CONSTRAINT workflows_runs_mode_check CHECK ((mode = ANY (ARRAY['PRODUCTION'::text, 'TEST'::text]))),
    CONSTRAINT workflows_runs_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'RUNNING'::text, 'SUCCEEDED'::text, 'FAILED'::text, 'CANCELLED'::text, 'INTERRUPTED'::text]))),
    CONSTRAINT workflows_runs_trigger_check CHECK ((trigger = ANY (ARRAY['MANUAL'::text, 'DATA_EVENT'::text, 'CRON'::text, 'WEBHOOK'::text])))
);

CREATE TABLE totalbase.workflows_steps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run uuid NOT NULL,
    operation uuid NOT NULL,
    operation_type text NOT NULL,
    configuration_version integer NOT NULL,
    sequence integer NOT NULL,
    predecessor uuid,
    status text NOT NULL,
    selected_output text,
    input jsonb,
    result jsonb,
    error jsonb,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT workflows_steps_status_check CHECK ((status = ANY (ARRAY['RUNNING'::text, 'SUCCEEDED'::text, 'FAILED'::text, 'CANCELLED'::text, 'INTERRUPTED'::text])))
);

CREATE TABLE totalbase.workflows_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workflow uuid NOT NULL,
    version integer NOT NULL,
    restored_from_version integer,
    definition_snapshot jsonb NOT NULL,
    "user" uuid,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    note text,
    CONSTRAINT workflows_versions_note_check CHECK ((length(note) <= 128)),
    CONSTRAINT workflows_versions_version_positive CHECK ((version > 0))
);

ALTER TABLE ONLY totalbase.roles_reviews
    ADD CONSTRAINT roles_reviews_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.tokens
    ADD CONSTRAINT tokens_key_hash_key UNIQUE (key_hash);

ALTER TABLE ONLY totalbase.tokens
    ADD CONSTRAINT tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.users_roles
    ADD CONSTRAINT users_roles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.users_roles
    ADD CONSTRAINT users_roles_user_role_key UNIQUE ("user", role);

COMMENT ON CONSTRAINT users_roles_user_role_key ON totalbase.users_roles IS 'The user already has this role.';

ALTER TABLE ONLY totalbase.audits_exclusions
    ADD CONSTRAINT audits_exclusions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.audits_exclusions
    ADD CONSTRAINT audits_exclusions_resource_column_attnum_key UNIQUE (resource, column_attnum);

ALTER TABLE ONLY totalbase.roles_capabilities
    ADD CONSTRAINT roles_capabilities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.roles_capabilities
    ADD CONSTRAINT roles_capabilities_role_capability_key UNIQUE (role, capability);

ALTER TABLE ONLY totalbase.invalidations
    ADD CONSTRAINT invalidations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.resources_columns
    ADD CONSTRAINT resources_columns_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.resources_columns
    ADD CONSTRAINT resources_columns_resource_attnum_key UNIQUE (resource, attnum);

ALTER TABLE ONLY totalbase.dashboards_embeds
    ADD CONSTRAINT dashboards_embeds_dashboard_name_key UNIQUE (dashboard, name);

ALTER TABLE ONLY totalbase.dashboards_embeds
    ADD CONSTRAINT dashboards_embeds_link_hash_key UNIQUE (link_hash);

ALTER TABLE ONLY totalbase.dashboards_embeds
    ADD CONSTRAINT dashboards_embeds_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.dashboards
    ADD CONSTRAINT dashboards_name_key UNIQUE (name);

ALTER TABLE ONLY totalbase.dashboards
    ADD CONSTRAINT dashboards_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.dashboards_roles
    ADD CONSTRAINT dashboards_roles_dashboard_role_key UNIQUE (dashboard, role);

ALTER TABLE ONLY totalbase.dashboards_roles
    ADD CONSTRAINT dashboards_roles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.dashboards
    ADD CONSTRAINT dashboards_slug_key UNIQUE (slug);

ALTER TABLE ONLY totalbase.dashboards_versions
    ADD CONSTRAINT dashboards_versions_dashboard_version_key UNIQUE (dashboard, version);

ALTER TABLE ONLY totalbase.dashboards_versions
    ADD CONSTRAINT dashboards_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.dashboards_widgets
    ADD CONSTRAINT dashboards_widgets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.dataviews
    ADD CONSTRAINT dataviews_name_key UNIQUE (name);

ALTER TABLE ONLY totalbase.dataviews
    ADD CONSTRAINT dataviews_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.dataviews_roles
    ADD CONSTRAINT dataviews_roles_dataview_role_key UNIQUE (dataview, role);

ALTER TABLE ONLY totalbase.dataviews_roles
    ADD CONSTRAINT dataviews_roles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.dataviews
    ADD CONSTRAINT dataviews_slug_key UNIQUE (slug);

ALTER TABLE ONLY totalbase.dataviews_versions
    ADD CONSTRAINT dataviews_versions_dataview_version_key UNIQUE (dataview, version);

ALTER TABLE ONLY totalbase.dataviews_versions
    ADD CONSTRAINT dataviews_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.executions
    ADD CONSTRAINT executions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.dataviews_fields
    ADD CONSTRAINT dataviews_fields_dataview_column_attnum_key UNIQUE (dataview, column_attnum);

ALTER TABLE ONLY totalbase.dataviews_fields
    ADD CONSTRAINT dataviews_fields_dataview_related_key UNIQUE (dataview, relation_attnum, target_attnum);

ALTER TABLE ONLY totalbase.dataviews_fields
    ADD CONSTRAINT dataviews_fields_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.files
    ADD CONSTRAINT files_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.folders
    ADD CONSTRAINT folders_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.idempotency_keys
    ADD CONSTRAINT idempotency_keys_principal_type_principal_operation_sc_key UNIQUE (principal_type, principal, operation_scope, key);

ALTER TABLE ONLY totalbase.identities
    ADD CONSTRAINT identities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.identities
    ADD CONSTRAINT identities_provider_provider_subject_key UNIQUE (provider, provider_subject);

ALTER TABLE ONLY totalbase.instance
    ADD CONSTRAINT instance_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.logs
    ADD CONSTRAINT logs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.menus
    ADD CONSTRAINT menus_dashboard_key UNIQUE (dashboard);

ALTER TABLE ONLY totalbase.menus
    ADD CONSTRAINT menus_dataview_key UNIQUE (dataview);

ALTER TABLE ONLY totalbase.menus
    ADD CONSTRAINT menus_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.outbox_admissions
    ADD CONSTRAINT outbox_admissions_event_workflow_item_key UNIQUE NULLS NOT DISTINCT (event, workflow, item);

ALTER TABLE ONLY totalbase.outbox_admissions
    ADD CONSTRAINT outbox_admissions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.outbox
    ADD CONSTRAINT outbox_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.permissions
    ADD CONSTRAINT permissions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.permissions
    ADD CONSTRAINT permissions_role_resource_action_key UNIQUE (role, resource, action);

ALTER TABLE ONLY totalbase.providers
    ADD CONSTRAINT providers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.providers
    ADD CONSTRAINT providers_slug_key UNIQUE (slug);

ALTER TABLE ONLY totalbase.sql_queries
    ADD CONSTRAINT sql_queries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.resources
    ADD CONSTRAINT resources_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.roles_managers
    ADD CONSTRAINT roles_managers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.roles_managers
    ADD CONSTRAINT roles_managers_role_manager_key UNIQUE (role, manager);

COMMENT ON CONSTRAINT roles_managers_role_manager_key ON totalbase.roles_managers IS 'That role already manages this one.';

ALTER TABLE ONLY totalbase.roles
    ADD CONSTRAINT roles_name_key UNIQUE (name);

COMMENT ON CONSTRAINT roles_name_key ON totalbase.roles IS 'A role with this name already exists.';

ALTER TABLE ONLY totalbase.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.secrets
    ADD CONSTRAINT secrets_key_key UNIQUE (key);

ALTER TABLE ONLY totalbase.secrets
    ADD CONSTRAINT secrets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.sessions
    ADD CONSTRAINT sessions_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY totalbase.settings
    ADD CONSTRAINT settings_key_key UNIQUE (key);

ALTER TABLE ONLY totalbase.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.dataviews_shares
    ADD CONSTRAINT dataviews_shares_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.dataviews_shares
    ADD CONSTRAINT dataviews_shares_state_role_key UNIQUE (state, role);

ALTER TABLE ONLY totalbase.dataviews_shares
    ADD CONSTRAINT dataviews_shares_state_user_key UNIQUE (state, "user");

ALTER TABLE ONLY totalbase.dataviews_states
    ADD CONSTRAINT dataviews_states_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.templates
    ADD CONSTRAINT templates_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.emails_tokens
    ADD CONSTRAINT emails_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.emails_tokens
    ADD CONSTRAINT emails_tokens_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY totalbase.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.workflows_crons
    ADD CONSTRAINT workflows_crons_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.workflows_crons
    ADD CONSTRAINT workflows_crons_workflow_scheduled_at_key UNIQUE (workflow, scheduled_at);

ALTER TABLE ONLY totalbase.workflows
    ADD CONSTRAINT workflows_name_unique UNIQUE (name);

ALTER TABLE ONLY totalbase.workflows
    ADD CONSTRAINT workflows_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.workflows_roles
    ADD CONSTRAINT workflows_roles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.workflows_roles
    ADD CONSTRAINT workflows_roles_role_workflow_key UNIQUE (role, workflow);

ALTER TABLE ONLY totalbase.workflows_runs
    ADD CONSTRAINT workflows_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.workflows
    ADD CONSTRAINT workflows_slug_unique UNIQUE (slug);

ALTER TABLE ONLY totalbase.workflows_steps
    ADD CONSTRAINT workflows_steps_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.workflows_steps
    ADD CONSTRAINT workflows_steps_run_sequence_key UNIQUE (run, sequence);

ALTER TABLE ONLY totalbase.workflows_versions
    ADD CONSTRAINT workflows_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY totalbase.workflows_versions
    ADD CONSTRAINT workflows_versions_workflow_version_key UNIQUE (workflow, version);

CREATE INDEX roles_reviews_reviewer_idx ON totalbase.roles_reviews USING btree (reviewer);

CREATE INDEX roles_reviews_role_idx ON totalbase.roles_reviews USING btree (role, created_at DESC);

CREATE INDEX tokens_previous_key_hash_idx ON totalbase.tokens USING btree (previous_key_hash) WHERE (previous_key_hash IS NOT NULL);

CREATE INDEX tokens_user_idx ON totalbase.tokens USING btree ("user");

CREATE UNIQUE INDEX tokens_user_name_unique ON totalbase.tokens USING btree ("user", lower(name));

COMMENT ON INDEX totalbase.tokens_user_name_unique IS 'This user already has a token with this name.';

CREATE INDEX users_roles_role_idx ON totalbase.users_roles USING btree (role);

CREATE INDEX invalidations_topic_created_at_idx ON totalbase.invalidations USING btree (topic, created_at);

CREATE INDEX dashboards_embeds_created_by_idx ON totalbase.dashboards_embeds USING btree (created_by);

CREATE INDEX dashboards_roles_role_idx ON totalbase.dashboards_roles USING btree (role);

CREATE INDEX dashboards_versions_user_idx ON totalbase.dashboards_versions USING btree ("user");

CREATE INDEX dashboards_widgets_dashboard_idx ON totalbase.dashboards_widgets USING btree (dashboard);

CREATE INDEX dataviews_owner_idx ON totalbase.dataviews USING btree (owner) WHERE (owner IS NOT NULL);

CREATE INDEX dataviews_roles_role_idx ON totalbase.dataviews_roles USING btree (role);

CREATE INDEX dataviews_source_resource_idx ON totalbase.dataviews USING btree (source_resource);

CREATE INDEX dataviews_versions_user_idx ON totalbase.dataviews_versions USING btree ("user");

CREATE INDEX executions_pending_idx ON totalbase.executions USING btree (available_at) WHERE (status = 'PENDING'::text);

CREATE INDEX executions_principal_idx ON totalbase.executions USING btree (principal_type, principal);

CREATE INDEX executions_stale_running_idx ON totalbase.executions USING btree (started_at) WHERE (status = 'RUNNING'::text);

CREATE INDEX dataviews_fields_parent_idx ON totalbase.dataviews_fields USING btree (parent) WHERE (parent IS NOT NULL);

CREATE INDEX dataviews_fields_related_dashboard_idx ON totalbase.dataviews_fields USING btree (related_dashboard) WHERE (related_dashboard IS NOT NULL);

CREATE INDEX dataviews_fields_related_dataview_idx ON totalbase.dataviews_fields USING btree (related_dataview) WHERE (related_dataview IS NOT NULL);

CREATE INDEX files_created_by_idx ON totalbase.files USING btree (created_by);

CREATE INDEX files_folder_name_idx ON totalbase.files USING btree (folder, name);

CREATE UNIQUE INDEX files_storage_key_unique ON totalbase.files USING btree (storage_provider, storage_key);

CREATE INDEX files_tags_idx ON totalbase.files USING gin (tags);

CREATE INDEX files_updated_by_idx ON totalbase.files USING btree (updated_by);

CREATE INDEX folders_created_by_idx ON totalbase.folders USING btree (created_by);

CREATE INDEX folders_parent_idx ON totalbase.folders USING btree (parent, name);

CREATE UNIQUE INDEX folders_parent_name_unique ON totalbase.folders USING btree (parent, lower(name)) WHERE (parent IS NOT NULL);

COMMENT ON INDEX totalbase.folders_parent_name_unique IS 'A folder with this name already exists here.';

CREATE UNIQUE INDEX folders_root_name_unique ON totalbase.folders USING btree (lower(name)) WHERE (parent IS NULL);

COMMENT ON INDEX totalbase.folders_root_name_unique IS 'A folder with this name already exists here.';

CREATE INDEX idempotency_keys_keys_expires_at_idx ON totalbase.idempotency_keys USING btree (expires_at);

CREATE INDEX identities_user_idx ON totalbase.identities USING btree ("user");

CREATE INDEX logs_created_at_idx ON totalbase.logs USING btree (created_at);

CREATE INDEX logs_event_created_idx ON totalbase.logs USING btree (event, created_at DESC) WHERE (event IS NOT NULL);

CREATE INDEX logs_principal_idx ON totalbase.logs USING btree (principal_type, principal);

CREATE INDEX logs_request_idx ON totalbase.logs USING btree (request_id);

CREATE INDEX logs_resource_idx ON totalbase.logs USING btree (resource);

CREATE INDEX logs_workflow_run_idx ON totalbase.logs USING btree (workflow_run, created_at) WHERE (workflow_run IS NOT NULL);

CREATE INDEX menus_parent_idx ON totalbase.menus USING btree (parent);

CREATE INDEX outbox_admissions_workflow_idx ON totalbase.outbox_admissions USING btree (workflow);

CREATE INDEX outbox_events_resource_idx ON totalbase.outbox USING btree (resource);

CREATE INDEX outbox_events_status_available_idx ON totalbase.outbox USING btree (status, available_at);

CREATE INDEX outbox_processed_at_idx ON totalbase.outbox USING btree (processed_at) WHERE (processed_at IS NOT NULL);

CREATE INDEX outbox_processing_lease_idx ON totalbase.outbox USING btree (locked_until) WHERE (status = 'PROCESSING'::text);

CREATE INDEX outbox_request_resource_event_idx ON totalbase.outbox USING btree (request_id, resource, event);

CREATE INDEX permissions_resource_idx ON totalbase.permissions USING btree (resource);

CREATE UNIQUE INDEX providers_one_per_type_idx ON totalbase.providers USING btree (type) WHERE (type = ANY (ARRAY['GOOGLE'::text, 'GITHUB'::text]));

CREATE INDEX sql_queries_admin_idx ON totalbase.sql_queries USING btree (admin);

CREATE INDEX sql_queries_created_at_idx ON totalbase.sql_queries USING btree (created_at);

CREATE UNIQUE INDEX resources_postgres_oid_unique ON totalbase.resources USING btree (postgres_oid);

CREATE INDEX resources_schema_name_idx ON totalbase.resources USING btree (schema, name);

CREATE INDEX roles_created_by_idx ON totalbase.roles USING btree (created_by);

CREATE INDEX roles_home_dashboard_idx ON totalbase.roles USING btree (home_dashboard) WHERE (home_dashboard IS NOT NULL);

CREATE INDEX roles_home_dataview_idx ON totalbase.roles USING btree (home_dataview) WHERE (home_dataview IS NOT NULL);

CREATE INDEX roles_managers_manager_idx ON totalbase.roles_managers USING btree (manager);

CREATE INDEX sessions_active_by_user_idx ON totalbase.sessions USING btree ("user") WHERE (revoked_at IS NULL);

CREATE INDEX sessions_last_seen_idx ON totalbase.sessions USING btree (last_seen_at DESC);

CREATE INDEX sessions_user_idx ON totalbase.sessions USING btree ("user");

CREATE INDEX dataviews_shares_role_idx ON totalbase.dataviews_shares USING btree (role);

CREATE INDEX dataviews_shares_user_idx ON totalbase.dataviews_shares USING btree ("user");

CREATE INDEX dataviews_states_dataview_idx ON totalbase.dataviews_states USING btree (dataview);

CREATE UNIQUE INDEX dataviews_states_dataview_user_current_unique ON totalbase.dataviews_states USING btree (dataview, "user") WHERE (name IS NULL);

CREATE UNIQUE INDEX dataviews_states_dataview_user_name_unique ON totalbase.dataviews_states USING btree (dataview, "user", name) WHERE (name IS NOT NULL);

CREATE INDEX dataviews_states_user_idx ON totalbase.dataviews_states USING btree ("user");

CREATE INDEX templates_kind_idx ON totalbase.templates USING btree (kind);

CREATE UNIQUE INDEX templates_name_unique ON totalbase.templates USING btree (name);

COMMENT ON INDEX totalbase.templates_name_unique IS 'A template with this name already exists.';

CREATE UNIQUE INDEX templates_slug_unique ON totalbase.templates USING btree (slug);

COMMENT ON INDEX totalbase.templates_slug_unique IS 'A template with this slug already exists.';

CREATE INDEX emails_tokens_unused_idx ON totalbase.emails_tokens USING btree (token_hash, type) WHERE (used_at IS NULL);

CREATE INDEX emails_tokens_user_idx ON totalbase.emails_tokens USING btree ("user");

CREATE UNIQUE INDEX users_email_unique ON totalbase.users USING btree (lower(email));

COMMENT ON INDEX totalbase.users_email_unique IS 'A user with this email already exists.';

CREATE UNIQUE INDEX users_owner_unique ON totalbase.users USING btree (owner) WHERE owner;

CREATE INDEX workflows_roles_workflow_idx ON totalbase.workflows_roles USING btree (workflow);

CREATE INDEX workflows_runs_finished_at_idx ON totalbase.workflows_runs USING btree (finished_at) WHERE (finished_at IS NOT NULL);

CREATE INDEX workflows_runs_list_idx ON totalbase.workflows_runs USING btree (workflow, created_at DESC);

CREATE INDEX workflows_runs_pending_idx ON totalbase.workflows_runs USING btree (status, created_at) WHERE (status = ANY (ARRAY['PENDING'::text, 'RUNNING'::text]));

CREATE INDEX workflows_runs_version_idx ON totalbase.workflows_runs USING btree (version);

CREATE INDEX workflows_steps_predecessor_idx ON totalbase.workflows_steps USING btree (predecessor) WHERE (predecessor IS NOT NULL);

CREATE INDEX workflows_versions_user_idx ON totalbase.workflows_versions USING btree ("user");

CREATE RULE instance_no_delete AS
    ON DELETE TO totalbase.instance DO INSTEAD NOTHING;

CREATE TRIGGER tokens_limited_changes BEFORE UPDATE ON totalbase.tokens FOR EACH ROW EXECUTE FUNCTION totalbase.tokens_limited_changes();

CREATE TRIGGER tokens_touch_updated_at BEFORE UPDATE ON totalbase.tokens FOR EACH ROW EXECUTE FUNCTION totalbase.tokens_touch_updated_at();

CREATE CONSTRAINT TRIGGER users_roles_owner_keeps_administrators AFTER DELETE ON totalbase.users_roles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION totalbase.users_roles_owner_keeps_administrators();

CREATE TRIGGER roles_capabilities_touch_updated_at BEFORE UPDATE ON totalbase.roles_capabilities FOR EACH ROW EXECUTE FUNCTION totalbase.touch_updated_at();

CREATE TRIGGER resources_columns_touch_updated_at BEFORE UPDATE ON totalbase.resources_columns FOR EACH ROW EXECUTE FUNCTION totalbase.touch_updated_at();

CREATE TRIGGER dashboards_embeds_touch_updated_at BEFORE UPDATE ON totalbase.dashboards_embeds FOR EACH ROW EXECUTE FUNCTION totalbase.touch_updated_at();

CREATE TRIGGER dashboards_touch_updated_at BEFORE UPDATE ON totalbase.dashboards FOR EACH ROW EXECUTE FUNCTION totalbase.touch_updated_at();

CREATE TRIGGER dashboards_widgets_touch_updated_at BEFORE UPDATE ON totalbase.dashboards_widgets FOR EACH ROW EXECUTE FUNCTION totalbase.touch_updated_at();

CREATE TRIGGER dataviews_touch_updated_at BEFORE UPDATE ON totalbase.dataviews FOR EACH ROW EXECUTE FUNCTION totalbase.touch_updated_at();

CREATE TRIGGER dataviews_fields_touch_updated_at BEFORE UPDATE ON totalbase.dataviews_fields FOR EACH ROW EXECUTE FUNCTION totalbase.touch_updated_at();

CREATE TRIGGER files_set_created_by BEFORE INSERT OR UPDATE ON totalbase.files FOR EACH ROW EXECUTE FUNCTION totalbase.set_created_by();

CREATE TRIGGER files_set_updated_by BEFORE INSERT OR UPDATE ON totalbase.files FOR EACH ROW EXECUTE FUNCTION totalbase.set_updated_by();

CREATE TRIGGER files_touch_updated_at BEFORE UPDATE ON totalbase.files FOR EACH ROW EXECUTE FUNCTION totalbase.touch_updated_at();

CREATE TRIGGER folders_set_created_by BEFORE INSERT OR UPDATE ON totalbase.folders FOR EACH ROW EXECUTE FUNCTION totalbase.set_created_by();

CREATE TRIGGER folders_touch_updated_at BEFORE UPDATE ON totalbase.folders FOR EACH ROW EXECUTE FUNCTION totalbase.touch_updated_at();

CREATE TRIGGER instance_touch_updated_at BEFORE UPDATE ON totalbase.instance FOR EACH ROW EXECUTE FUNCTION totalbase.touch_updated_at();

CREATE TRIGGER menus_parent_is_group BEFORE INSERT OR UPDATE OF parent ON totalbase.menus FOR EACH ROW EXECUTE FUNCTION totalbase.menus_parent_is_group();

CREATE TRIGGER menus_touch_updated_at BEFORE UPDATE ON totalbase.menus FOR EACH ROW EXECUTE FUNCTION totalbase.touch_updated_at();

CREATE TRIGGER permissions_touch_updated_at BEFORE UPDATE ON totalbase.permissions FOR EACH ROW EXECUTE FUNCTION totalbase.touch_updated_at();

CREATE TRIGGER providers_touch_updated_at BEFORE UPDATE ON totalbase.providers FOR EACH ROW EXECUTE FUNCTION totalbase.touch_updated_at();

CREATE TRIGGER resources_touch_updated_at BEFORE UPDATE ON totalbase.resources FOR EACH ROW EXECUTE FUNCTION totalbase.touch_updated_at();

CREATE TRIGGER roles_reserved_unchanged BEFORE DELETE OR UPDATE ON totalbase.roles FOR EACH ROW EXECUTE FUNCTION totalbase.roles_reserved_unchanged();

CREATE TRIGGER roles_set_created_by BEFORE INSERT OR UPDATE ON totalbase.roles FOR EACH ROW EXECUTE FUNCTION totalbase.set_created_by();

CREATE TRIGGER roles_touch_updated_at BEFORE UPDATE ON totalbase.roles FOR EACH ROW EXECUTE FUNCTION totalbase.touch_updated_at();

CREATE TRIGGER secrets_touch_updated_at BEFORE UPDATE ON totalbase.secrets FOR EACH ROW EXECUTE FUNCTION totalbase.touch_updated_at();

CREATE TRIGGER sessions_only_revocation BEFORE UPDATE ON totalbase.sessions FOR EACH ROW EXECUTE FUNCTION totalbase.sessions_only_revocation();

CREATE TRIGGER settings_touch_updated_at BEFORE UPDATE ON totalbase.settings FOR EACH ROW EXECUTE FUNCTION totalbase.touch_updated_at();

CREATE TRIGGER dataviews_states_touch_updated_at BEFORE UPDATE ON totalbase.dataviews_states FOR EACH ROW EXECUTE FUNCTION totalbase.touch_updated_at();

CREATE TRIGGER templates_touch_updated_at BEFORE UPDATE ON totalbase.templates FOR EACH ROW EXECUTE FUNCTION totalbase.touch_updated_at();

CREATE TRIGGER roles_reviews_fill BEFORE INSERT OR UPDATE ON totalbase.roles_reviews FOR EACH ROW EXECUTE FUNCTION totalbase.roles_reviews_fill();

CREATE TRIGGER instance_protect_id_trg BEFORE UPDATE ON totalbase.instance FOR EACH ROW EXECUTE FUNCTION totalbase.instance_protect_id();

CREATE TRIGGER openapi_revision AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON totalbase.roles_capabilities FOR EACH STATEMENT EXECUTE FUNCTION totalbase.bump_openapi_revision();

CREATE TRIGGER openapi_revision AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON totalbase.resources_columns FOR EACH STATEMENT EXECUTE FUNCTION totalbase.bump_openapi_revision();

CREATE TRIGGER openapi_revision AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON totalbase.permissions FOR EACH STATEMENT EXECUTE FUNCTION totalbase.bump_openapi_revision();

CREATE TRIGGER openapi_revision AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON totalbase.resources FOR EACH STATEMENT EXECUTE FUNCTION totalbase.bump_openapi_revision();

CREATE TRIGGER openapi_revision AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON totalbase.roles FOR EACH STATEMENT EXECUTE FUNCTION totalbase.bump_openapi_revision();

CREATE TRIGGER openapi_revision AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON totalbase.settings FOR EACH STATEMENT EXECUTE FUNCTION totalbase.bump_openapi_revision();

CREATE TRIGGER openapi_revision AFTER INSERT OR DELETE OR TRUNCATE ON totalbase.workflows FOR EACH STATEMENT EXECUTE FUNCTION totalbase.bump_openapi_revision();

CREATE TRIGGER openapi_revision AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON totalbase.workflows_roles FOR EACH STATEMENT EXECUTE FUNCTION totalbase.bump_openapi_revision();

CREATE TRIGGER openapi_revision AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON totalbase.workflows_versions FOR EACH STATEMENT EXECUTE FUNCTION totalbase.bump_openapi_revision();

CREATE TRIGGER openapi_revision_update AFTER UPDATE ON totalbase.workflows FOR EACH ROW WHEN (((old.name IS DISTINCT FROM new.name) OR (old.description IS DISTINCT FROM new.description) OR (old.slug IS DISTINCT FROM new.slug) OR (old.enabled IS DISTINCT FROM new.enabled))) EXECUTE FUNCTION totalbase.bump_openapi_revision();

CREATE TRIGGER protect_workflows_role_assignment_trg BEFORE INSERT OR UPDATE ON totalbase.users_roles FOR EACH ROW EXECUTE FUNCTION totalbase.protect_workflows_role_assignment();

CREATE TRIGGER protect_workflows_user_delete_trg BEFORE DELETE ON totalbase.users FOR EACH ROW EXECUTE FUNCTION totalbase.protect_workflows_user_delete();

CREATE TRIGGER users_keep_active BEFORE UPDATE OF active ON totalbase.users FOR EACH ROW EXECUTE FUNCTION totalbase.users_keep_active();

CREATE TRIGGER users_keep_owner BEFORE DELETE ON totalbase.users FOR EACH ROW EXECUTE FUNCTION totalbase.users_keep_owner();

CREATE TRIGGER users_protect_admin_accounts BEFORE DELETE OR UPDATE ON totalbase.users FOR EACH ROW EXECUTE FUNCTION totalbase.protect_admin_accounts();

CREATE TRIGGER users_revoke_sessions_on_deactivate AFTER UPDATE OF active ON totalbase.users FOR EACH ROW EXECUTE FUNCTION totalbase.users_revoke_sessions_on_deactivate();

CREATE TRIGGER users_touch_updated_at BEFORE UPDATE ON totalbase.users FOR EACH ROW EXECUTE FUNCTION totalbase.touch_updated_at();

CREATE TRIGGER workflows_touch_updated_at BEFORE UPDATE ON totalbase.workflows FOR EACH ROW EXECUTE FUNCTION totalbase.touch_updated_at();

ALTER TABLE ONLY totalbase.roles_reviews
    ADD CONSTRAINT roles_reviews_reviewer_fkey FOREIGN KEY (reviewer) REFERENCES totalbase.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY totalbase.roles_reviews
    ADD CONSTRAINT roles_reviews_role_fkey FOREIGN KEY (role) REFERENCES totalbase.roles(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.tokens
    ADD CONSTRAINT tokens_user_fkey FOREIGN KEY ("user") REFERENCES totalbase.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.users_roles
    ADD CONSTRAINT users_roles_role_fkey FOREIGN KEY (role) REFERENCES totalbase.roles(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.users_roles
    ADD CONSTRAINT users_roles_user_fkey FOREIGN KEY ("user") REFERENCES totalbase.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.audits_exclusions
    ADD CONSTRAINT audits_exclusions_resource_fkey FOREIGN KEY (resource) REFERENCES totalbase.resources(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.roles_capabilities
    ADD CONSTRAINT roles_capabilities_role_fkey FOREIGN KEY (role) REFERENCES totalbase.roles(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.resources_columns
    ADD CONSTRAINT resources_columns_resource_fkey FOREIGN KEY (resource) REFERENCES totalbase.resources(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.dashboards_embeds
    ADD CONSTRAINT dashboards_embeds_created_by_fkey FOREIGN KEY (created_by) REFERENCES totalbase.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY totalbase.dashboards_embeds
    ADD CONSTRAINT dashboards_embeds_dashboard_fkey FOREIGN KEY (dashboard) REFERENCES totalbase.dashboards(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.dashboards_roles
    ADD CONSTRAINT dashboards_roles_dashboard_fkey FOREIGN KEY (dashboard) REFERENCES totalbase.dashboards(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.dashboards_roles
    ADD CONSTRAINT dashboards_roles_role_fkey FOREIGN KEY (role) REFERENCES totalbase.roles(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.dashboards_versions
    ADD CONSTRAINT dashboards_versions_dashboard_fkey FOREIGN KEY (dashboard) REFERENCES totalbase.dashboards(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.dashboards_versions
    ADD CONSTRAINT dashboards_versions_user_fkey FOREIGN KEY ("user") REFERENCES totalbase.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY totalbase.dashboards_widgets
    ADD CONSTRAINT dashboards_widgets_dashboard_fkey FOREIGN KEY (dashboard) REFERENCES totalbase.dashboards(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.dataviews
    ADD CONSTRAINT dataviews_owner_fkey FOREIGN KEY (owner) REFERENCES totalbase.dataviews(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.dataviews_roles
    ADD CONSTRAINT dataviews_roles_dataview_fkey FOREIGN KEY (dataview) REFERENCES totalbase.dataviews(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.dataviews_roles
    ADD CONSTRAINT dataviews_roles_role_fkey FOREIGN KEY (role) REFERENCES totalbase.roles(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.dataviews
    ADD CONSTRAINT dataviews_source_resource_fkey FOREIGN KEY (source_resource) REFERENCES totalbase.resources(id) ON DELETE RESTRICT;

ALTER TABLE ONLY totalbase.dataviews_versions
    ADD CONSTRAINT dataviews_versions_dataview_fkey FOREIGN KEY (dataview) REFERENCES totalbase.dataviews(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.dataviews_versions
    ADD CONSTRAINT dataviews_versions_user_fkey FOREIGN KEY ("user") REFERENCES totalbase.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY totalbase.dataviews_fields
    ADD CONSTRAINT dataviews_fields_dataview_fkey FOREIGN KEY (dataview) REFERENCES totalbase.dataviews(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.dataviews_fields
    ADD CONSTRAINT dataviews_fields_parent_fkey FOREIGN KEY (parent) REFERENCES totalbase.dataviews_fields(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.dataviews_fields
    ADD CONSTRAINT dataviews_fields_related_dashboard_fkey FOREIGN KEY (related_dashboard) REFERENCES totalbase.dashboards(id) ON DELETE RESTRICT;

ALTER TABLE ONLY totalbase.dataviews_fields
    ADD CONSTRAINT dataviews_fields_related_dataview_fkey FOREIGN KEY (related_dataview) REFERENCES totalbase.dataviews(id) ON DELETE RESTRICT;

ALTER TABLE ONLY totalbase.files
    ADD CONSTRAINT files_created_by_fkey FOREIGN KEY (created_by) REFERENCES totalbase.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY totalbase.files
    ADD CONSTRAINT files_folder_fkey FOREIGN KEY (folder) REFERENCES totalbase.folders(id) ON DELETE RESTRICT;

ALTER TABLE ONLY totalbase.files
    ADD CONSTRAINT files_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES totalbase.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY totalbase.folders
    ADD CONSTRAINT folders_created_by_fkey FOREIGN KEY (created_by) REFERENCES totalbase.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY totalbase.folders
    ADD CONSTRAINT folders_parent_fkey FOREIGN KEY (parent) REFERENCES totalbase.folders(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.identities
    ADD CONSTRAINT identities_provider_fkey FOREIGN KEY (provider) REFERENCES totalbase.providers(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.identities
    ADD CONSTRAINT identities_user_fkey FOREIGN KEY ("user") REFERENCES totalbase.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.logs
    ADD CONSTRAINT logs_resource_fkey FOREIGN KEY (resource) REFERENCES totalbase.resources(id) ON DELETE SET NULL;

ALTER TABLE ONLY totalbase.menus
    ADD CONSTRAINT menus_dashboard_fkey FOREIGN KEY (dashboard) REFERENCES totalbase.dashboards(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.menus
    ADD CONSTRAINT menus_dataview_fkey FOREIGN KEY (dataview) REFERENCES totalbase.dataviews(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.menus
    ADD CONSTRAINT menus_parent_fkey FOREIGN KEY (parent) REFERENCES totalbase.menus(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.outbox_admissions
    ADD CONSTRAINT outbox_admissions_event_fkey FOREIGN KEY (event) REFERENCES totalbase.outbox(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.outbox_admissions
    ADD CONSTRAINT outbox_admissions_workflow_fkey FOREIGN KEY (workflow) REFERENCES totalbase.workflows(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.outbox
    ADD CONSTRAINT outbox_resource_fkey FOREIGN KEY (resource) REFERENCES totalbase.resources(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.permissions
    ADD CONSTRAINT permissions_resource_fkey FOREIGN KEY (resource) REFERENCES totalbase.resources(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.permissions
    ADD CONSTRAINT permissions_role_fkey FOREIGN KEY (role) REFERENCES totalbase.roles(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.sql_queries
    ADD CONSTRAINT sql_queries_admin_fkey FOREIGN KEY (admin) REFERENCES totalbase.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.roles
    ADD CONSTRAINT roles_created_by_fkey FOREIGN KEY (created_by) REFERENCES totalbase.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY totalbase.roles
    ADD CONSTRAINT roles_home_dashboard_fkey FOREIGN KEY (home_dashboard) REFERENCES totalbase.dashboards(id) ON DELETE SET NULL;

ALTER TABLE ONLY totalbase.roles
    ADD CONSTRAINT roles_home_dataview_fkey FOREIGN KEY (home_dataview) REFERENCES totalbase.dataviews(id) ON DELETE SET NULL;

ALTER TABLE ONLY totalbase.roles_managers
    ADD CONSTRAINT roles_managers_manager_fkey FOREIGN KEY (manager) REFERENCES totalbase.roles(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.roles_managers
    ADD CONSTRAINT roles_managers_role_fkey FOREIGN KEY (role) REFERENCES totalbase.roles(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.sessions
    ADD CONSTRAINT sessions_user_fkey FOREIGN KEY ("user") REFERENCES totalbase.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.dataviews_shares
    ADD CONSTRAINT dataviews_shares_role_fkey FOREIGN KEY (role) REFERENCES totalbase.roles(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.dataviews_shares
    ADD CONSTRAINT dataviews_shares_state_fkey FOREIGN KEY (state) REFERENCES totalbase.dataviews_states(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.dataviews_shares
    ADD CONSTRAINT dataviews_shares_user_fkey FOREIGN KEY ("user") REFERENCES totalbase.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.dataviews_states
    ADD CONSTRAINT dataviews_states_dataview_fkey FOREIGN KEY (dataview) REFERENCES totalbase.dataviews(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.dataviews_states
    ADD CONSTRAINT dataviews_states_user_fkey FOREIGN KEY ("user") REFERENCES totalbase.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.emails_tokens
    ADD CONSTRAINT emails_tokens_user_fkey FOREIGN KEY ("user") REFERENCES totalbase.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.workflows_crons
    ADD CONSTRAINT workflows_crons_workflow_fkey FOREIGN KEY (workflow) REFERENCES totalbase.workflows(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.workflows_roles
    ADD CONSTRAINT workflows_roles_role_fkey FOREIGN KEY (role) REFERENCES totalbase.roles(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.workflows_roles
    ADD CONSTRAINT workflows_roles_workflow_fkey FOREIGN KEY (workflow) REFERENCES totalbase.workflows(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.workflows_runs
    ADD CONSTRAINT workflows_runs_version_fkey FOREIGN KEY (version) REFERENCES totalbase.workflows_versions(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.workflows_runs
    ADD CONSTRAINT workflows_runs_workflow_fkey FOREIGN KEY (workflow) REFERENCES totalbase.workflows(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.workflows_steps
    ADD CONSTRAINT workflows_steps_predecessor_fkey FOREIGN KEY (predecessor) REFERENCES totalbase.workflows_steps(id);

ALTER TABLE ONLY totalbase.workflows_steps
    ADD CONSTRAINT workflows_steps_run_fkey FOREIGN KEY (run) REFERENCES totalbase.workflows_runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY totalbase.workflows_versions
    ADD CONSTRAINT workflows_versions_user_fkey FOREIGN KEY ("user") REFERENCES totalbase.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY totalbase.workflows_versions
    ADD CONSTRAINT workflows_versions_workflow_fkey FOREIGN KEY (workflow) REFERENCES totalbase.workflows(id) ON DELETE CASCADE;

--
--

-- The system's own rows: the Administrators role, and the Workflows role and account a published
-- workflow runs as by default (Specification_Security.md §1, Specification_Workflows.md §6). The first
-- administrator is created at first start from TOTALBASE_ADMIN_EMAIL (apps/server bootstrap).
INSERT INTO totalbase.roles (name, reserved, admin_access, app_access, api_access)
VALUES ('Administrators', true, true, true, true), ('Workflows', true, true, true, true);

INSERT INTO totalbase.users (email, name, password_hash, active, can_login, email_verified_at)
VALUES ('workflows@system.totalbase.internal', 'Workflows', NULL, true, false, now());

INSERT INTO totalbase.users_roles ("user", role)
SELECT u.id, r.id FROM totalbase.users u, totalbase.roles r
WHERE u.email = 'workflows@system.totalbase.internal' AND r.name = 'Workflows';

-- What each table holds.
COMMENT ON TABLE totalbase.audits_exclusions IS 'Columns a resource leaves out of the audit log: their values are never recorded in a log entry''s payload or changes, for data too sensitive to copy into the log.';
COMMENT ON TABLE totalbase.dashboards IS 'A dashboard: a canvas of widgets, each fed by a read-only SQL query an administrator writes, with variables viewers pick. This row holds its draft and settings; what viewers see is its live version.';
COMMENT ON TABLE totalbase.dashboards_embeds IS 'Ways a published dashboard is shown outside TotalBase: a public LINK, or a SIGNED embed a portal''s backend authorizes per visit - its display options, the variables it locks, the sites that may frame it, expiry and revocation.';
COMMENT ON TABLE totalbase.dashboards_roles IS 'Roles that may open a published dashboard in the App. A dashboard shows what its author''s queries return, so this is the whole of its access.';
COMMENT ON TABLE totalbase.dashboards_versions IS 'Immutable published versions of a dashboard: snapshots of its widgets and variables. The live version is the highest; restoring copies one back into the draft.';
COMMENT ON TABLE totalbase.dashboards_widgets IS 'The draft widgets of a dashboard: type, query, configuration and place on the grid. Publishing copies them into dashboards_versions, which is what viewers see.';
COMMENT ON TABLE totalbase.dataviews IS 'A DataView: a screen over a table or view (Table, Cards, Kanban, Calendar, Gantt, Map, Tree, Form, Master-detail), a custom page, or an external frame. This row holds its draft; users see its live version.';
COMMENT ON TABLE totalbase.dataviews_fields IS 'What a DataView shows: one row per column, related column or widget placed in it, with its position, its widget and that widget''s configuration. Draft; published in dataviews_versions.';
COMMENT ON TABLE totalbase.dataviews_roles IS 'Roles that may open a published DataView in the App. Opening it grants no data: every read and write still goes through the resource''s own permissions.';
COMMENT ON TABLE totalbase.dataviews_shares IS 'A saved view (a named row of dataviews_states) shared with one user or one role. They apply it or copy it as their own, never change it.';
COMMENT ON TABLE totalbase.dataviews_states IS 'A user''s state of a DataView''s list - columns, sort, filter, density: the one remembered automatically (no name), or a saved view they named and may share.';
COMMENT ON TABLE totalbase.dataviews_versions IS 'Immutable published versions of a DataView: snapshots of its configuration, fields, code and the presentation it inherits. The live version is the highest.';
COMMENT ON TABLE totalbase.emails_tokens IS 'Single-use tokens sent by email: invitations, password resets and email verifications. Only a hash is stored; a token works once, until it expires.';
COMMENT ON TABLE totalbase.executions IS 'Asynchronous executions - a function call or a transaction queued with Prefer: respond-async - run by the in-process worker. Their request, result and error never hold secrets.';
COMMENT ON TABLE totalbase.files IS 'Files: their metadata here, their content in the configured storage. Each belongs to a folder and is private unless marked public.';
COMMENT ON TABLE totalbase.folders IS 'Folders that organize files in the Files screen. They group files for people; storage paths don''t follow them.';
COMMENT ON TABLE totalbase.idempotency_keys IS 'Idempotency-Key records: a retried request with the same key gets the first response again instead of running twice. Only successful responses are kept, until they expire.';
COMMENT ON TABLE totalbase.identities IS 'Links between a user and their account at an external sign-in provider (OAuth or OpenID Connect).';
COMMENT ON TABLE totalbase.instance IS 'This installation: exactly one row, whose id identifies it for good. It can''t be deleted.';
COMMENT ON TABLE totalbase.invalidations IS 'Short-lived signals that something cached must be read again - today, the OpenAPI document after a change to resources or permissions. Rows older than an hour are deleted.';
COMMENT ON TABLE totalbase.logs IS 'The audit log: one entry per audited request - who (user, token, session, address), on which resource, the action and its outcome, and for a write the values before and after. Written in the write''s own transaction.';
COMMENT ON TABLE totalbase.menus IS 'The App menu: groups and entries - a DataView or a dashboard - in order. Each user sees only the entries they may open.';
COMMENT ON TABLE totalbase.outbox IS 'One event per row written through TotalBase, recorded in the write''s own transaction and delivered after it commits - to webhooks and Database event workflows - retried until delivered.';
COMMENT ON TABLE totalbase.outbox_admissions IS 'Which workflow runs an outbox event admitted, one per workflow and record - so a retried event never starts the same run twice.';
COMMENT ON TABLE totalbase.permissions IS 'What a role may do on a resource: one grant per role, resource and action (READ, CREATE, UPDATE, DELETE, EXECUTE), ALLOW or DENY, with its fields, row filter and payload checks. Any DENY wins; no grant means no access.';
COMMENT ON TABLE totalbase.providers IS 'External sign-in providers (OAuth or OpenID Connect): their configuration and how users sign in with them. Their client secrets are in secrets.';
COMMENT ON TABLE totalbase.resources IS 'Every table, view and function TotalBase knows, by PostgreSQL OID: a stable id that survives a rename, and how it is exposed through the Data API. A dropped and recreated object is a new resource, hidden.';
COMMENT ON TABLE totalbase.resources_columns IS 'TotalBase''s settings for one column of a table or view - its presentation (label, format, input, options) - inherited by every DataView that shows it.';
COMMENT ON TABLE totalbase.roles IS 'Roles: what a user may reach (the admin, the App, the API) and, through their permissions, what they may do. A user holds several; the reserved ones can''t be renamed or deleted.';
COMMENT ON TABLE totalbase.roles_capabilities IS 'What a role may do beyond rows: run multi-step transactions (TRANSACTIONS), send email from a workflow (SEND_EMAIL). ALLOW or DENY, one per role and capability.';
COMMENT ON TABLE totalbase.roles_managers IS 'Delegated administration: which roles may assign a role to users (manager), set by an administrator. A role never manages itself.';
COMMENT ON TABLE totalbase.roles_reviews IS 'Access reviews: who reviewed a role, when, who held it at the time, and the outcome. The reviewer, the members and the time are filled in on insert; a review never changes afterwards.';
COMMENT ON TABLE totalbase.secrets IS 'Reusable secrets - SMTP passwords, provider client secrets, API keys a workflow sends - encrypted with the instance''s master key (TOTALBASE_MASTER_KEY, never stored here). Values are never read back.';
COMMENT ON TABLE totalbase.sessions IS 'Sign-in sessions: an opaque bearer token per signed-in browser or device, stored as a hash, until it expires or is revoked.';
COMMENT ON TABLE totalbase.settings IS 'The instance''s settings that differ from their defaults. Every setting, its type and its default are defined in code; a row here overrides one.';
COMMENT ON TABLE totalbase.sql_queries IS 'The SQL Console''s history: each statement an administrator ran, with its outcome, duration and error.';
COMMENT ON TABLE totalbase.templates IS 'Reusable templates: MAILING (an email''s subject and message, with {{variables}}) or PDF (a document layout), used by workflows and by the App.';
COMMENT ON TABLE totalbase.tokens IS 'Personal access tokens for the APIs: each belongs to a user and acts as them. An API token carries its owner''s roles, read live; an ADMIN token also requires its owner to be an administrator. Only a hash is stored.';
COMMENT ON TABLE totalbase.users IS 'Users. Extensible: an installation may add its own columns, indexes and foreign keys, and TotalBase''s migrations keep them.';
COMMENT ON TABLE totalbase.users_roles IS 'Which roles each user holds: one row per user and role. A user''s permissions are their roles'' grants combined.';
COMMENT ON TABLE totalbase.workflows IS 'A workflow: its draft definition (steps and connections), trigger, settings and revision. What runs is its live version.';
COMMENT ON TABLE totalbase.workflows_crons IS 'Claims on a Schedule workflow''s run times: one row per workflow and scheduled time, so each time starts once even with several instances running.';
COMMENT ON TABLE totalbase.workflows_roles IS 'Roles that may run a workflow on demand (its Manual trigger), from the App or the API.';
COMMENT ON TABLE totalbase.workflows_runs IS 'Each run of a workflow: its version, trigger, who started it and as whom it ran, status, result or error, and timing.';
COMMENT ON TABLE totalbase.workflows_steps IS 'Each step a workflow run executed: the operation, its input and output, the output it took, its status and timing - the run''s trace.';
COMMENT ON TABLE totalbase.workflows_versions IS 'Immutable published versions of a workflow: snapshots of its definition. The live version is the highest; a run records which one it ran.';
