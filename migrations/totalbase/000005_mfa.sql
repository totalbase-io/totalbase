-- Multi-factor authentication (Security.md §2.17): TOTP factors, their recovery codes, and the sign-in
-- challenges between a correct password and the code. New tables, never columns on totalbase.users (it is
-- the developer's to extend, Foundations.md §10.4). None is exposed through the Data API (Security.md §10.1):
-- only the authentication service reads or writes them.

-- One factor per user and type. The secret is encrypted with the master key; confirmed_at is NULL while
-- enrollment waits for its first code, and only a confirmed factor is asked at sign-in. last_used_step is the
-- newest TOTP step accepted - a code is good once.
CREATE TABLE totalbase.factors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "user" uuid NOT NULL,
    type text DEFAULT 'TOTP'::text NOT NULL,
    secret text NOT NULL,
    confirmed_at timestamp with time zone,
    last_used_step bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT factors_pkey PRIMARY KEY (id),
    CONSTRAINT factors_type_check CHECK ((type = ANY (ARRAY['TOTP'::text]))),
    CONSTRAINT factors_user_type_key UNIQUE ("user", type),
    CONSTRAINT factors_user_fkey FOREIGN KEY ("user") REFERENCES totalbase.users(id) ON DELETE CASCADE
);

COMMENT ON TABLE totalbase.factors IS 'Second sign-in factors (TOTP authenticator apps), one per user and type. The secret is encrypted with the master key; an unconfirmed factor is an enrollment not finished.';

CREATE TRIGGER factors_touch_updated_at BEFORE UPDATE ON totalbase.factors FOR EACH ROW EXECUTE FUNCTION totalbase.touch_updated_at();

-- Ten single-use recovery codes per confirmed factor, as SHA-256 hashes; regenerating replaces them all,
-- and they go with the factor.
CREATE TABLE totalbase.factors_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    factor uuid NOT NULL,
    code_hash text NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT factors_codes_pkey PRIMARY KEY (id),
    CONSTRAINT factors_codes_code_hash_key UNIQUE (code_hash),
    CONSTRAINT factors_codes_factor_fkey FOREIGN KEY (factor) REFERENCES totalbase.factors(id) ON DELETE CASCADE
);

CREATE INDEX factors_codes_factor_idx ON totalbase.factors_codes USING btree (factor);

COMMENT ON TABLE totalbase.factors_codes IS 'Single-use recovery codes of a second factor, for a lost phone - stored as hashes, shown once.';

-- What a correct password gets instead of a session when a second step is due: VERIFY (enter the code) or
-- ENROLL (the policy requires a factor the user doesn't have yet). Single-use, short-lived, hashed like a
-- session token; grants nothing but that step, on the surface it was issued for.
CREATE TABLE totalbase.challenges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "user" uuid NOT NULL,
    purpose text NOT NULL,
    surface text NOT NULL,
    token_hash text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT challenges_pkey PRIMARY KEY (id),
    CONSTRAINT challenges_purpose_check CHECK ((purpose = ANY (ARRAY['VERIFY'::text, 'ENROLL'::text]))),
    CONSTRAINT challenges_surface_check CHECK ((surface = ANY (ARRAY['API'::text, 'PORTAL'::text]))),
    CONSTRAINT challenges_token_hash_key UNIQUE (token_hash),
    CONSTRAINT challenges_user_fkey FOREIGN KEY ("user") REFERENCES totalbase.users(id) ON DELETE CASCADE
);

CREATE INDEX challenges_user_idx ON totalbase.challenges USING btree ("user");
CREATE INDEX challenges_expires_at_idx ON totalbase.challenges USING btree (expires_at);

COMMENT ON TABLE totalbase.challenges IS 'The step between a correct password and a session when a second factor is due: single-use, about five minutes, stored as a hash.';

-- When the session's second factor was checked (NULL: the account had none) - for a later step-up.
ALTER TABLE totalbase.sessions ADD COLUMN mfa_verified_at timestamp with time zone;

COMMENT ON COLUMN totalbase.sessions.mfa_verified_at IS 'When this sign-in passed its second factor; NULL when the account had none.';

-- A write on someone's behalf still only revokes (Security.md §2.2): the new column is kept like the others.
CREATE OR REPLACE FUNCTION totalbase.sessions_only_revocation() RETURNS trigger
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
  NEW.mfa_verified_at := OLD.mfa_verified_at;
  NEW.revoked_at := CASE
    WHEN OLD.revoked_at IS NOT NULL THEN OLD.revoked_at
    WHEN NEW.revoked_at IS NOT NULL THEN now()
    ELSE NULL
  END;
  RETURN NEW;
END;
$$;
