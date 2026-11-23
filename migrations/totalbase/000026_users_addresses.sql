-- Sign-in lockout per account and address (Security.md §2.4): wrong passwords from one address lock that address out
-- of the account, never the account for everyone - otherwise anyone knowing an email keeps its owner out.
-- `signed_in_at` marks an address the account signed in from: it skips the account-wide delay below.
CREATE TABLE totalbase.users_addresses (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "user" uuid NOT NULL REFERENCES totalbase.users (id) ON DELETE CASCADE,
    ip inet NOT NULL,
    failed_count integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    signed_in_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_addresses_user_ip_key UNIQUE ("user", ip),
    CONSTRAINT users_addresses_failed_count_check CHECK (failed_count >= 0)
);

COMMENT ON TABLE totalbase.users_addresses IS 'Sign-in attempts per account and address (Security.md §2.4): a lock per address, and the addresses the account signed in from.';

-- Across addresses it never signed in from, an account's sign-ins slow down instead of locking: past
-- auth.lockout_max_attempts failures each attempt waits its turn, a delay doubling up to five minutes.
ALTER TABLE totalbase.users ADD COLUMN IF NOT EXISTS sign_in_failures integer DEFAULT 0 NOT NULL;
ALTER TABLE totalbase.users ADD COLUMN IF NOT EXISTS sign_in_delayed_until timestamp with time zone;

COMMENT ON COLUMN totalbase.users.sign_in_failures IS 'Consecutive failed sign-ins from addresses the account never signed in from (Security.md §2.4).';
COMMENT ON COLUMN totalbase.users.sign_in_delayed_until IS 'No sign-in from an address the account never signed in from is checked before this (Security.md §2.4).';
