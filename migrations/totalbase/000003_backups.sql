-- Built-in backups (Administration.md §12): each backup is a row - its queue entry while PENDING, its
-- record once it ran. The row is the job: a worker claims it with FOR UPDATE SKIP LOCKED and renews
-- locked_at while pg_dump runs; one backup at a time per instance, which PostgreSQL enforces with the
-- partial unique index below, so two processes never run two. A scheduled occurrence is inserted once
-- (UNIQUE scheduled_for), whichever process sees the minute first.
CREATE TABLE totalbase.backups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    trigger text NOT NULL,
    scheduled_for timestamp with time zone,
    requested_by uuid,
    destination text NOT NULL,
    name text NOT NULL,
    size_bytes bigint,
    manifest jsonb,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    locked_at timestamp with time zone,
    locked_by text,
    CONSTRAINT backups_pkey PRIMARY KEY (id),
    CONSTRAINT backups_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'RUNNING'::text, 'COMPLETED'::text, 'FAILED'::text]))),
    CONSTRAINT backups_trigger_check CHECK ((trigger = ANY (ARRAY['SCHEDULED'::text, 'MANUAL'::text]))),
    CONSTRAINT backups_destination_check CHECK ((destination = ANY (ARRAY['LOCAL'::text, 'S3'::text]))),
    CONSTRAINT backups_scheduled_check CHECK (((trigger = 'SCHEDULED'::text) = (scheduled_for IS NOT NULL))),
    CONSTRAINT backups_name_check CHECK ((name ~ '^totalbase-[0-9]{8}-[0-9]{6}-[0-9a-f]{8}\.tar$'::text)),
    CONSTRAINT backups_error_check CHECK ((length(error) <= 2000)),
    CONSTRAINT backups_scheduled_for_key UNIQUE (scheduled_for),
    CONSTRAINT backups_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES totalbase.users(id) ON DELETE SET NULL
);

-- One backup queued or running at a time: a second Back up now is refused, a scheduled occurrence that
-- finds one is skipped.
CREATE UNIQUE INDEX backups_one_active ON totalbase.backups ((true)) WHERE (status = ANY (ARRAY['PENDING'::text, 'RUNNING'::text]));
CREATE INDEX backups_created_at_idx ON totalbase.backups (created_at DESC);

COMMENT ON TABLE totalbase.backups IS 'Built-in backups: one row per backup - queued, running, completed or failed - and where its archive is. The archive holds the database dump, the stored files and a manifest; never the master key.';
COMMENT ON COLUMN totalbase.backups.trigger IS 'SCHEDULED: an occurrence of backups.schedule; MANUAL: Back up now.';
COMMENT ON COLUMN totalbase.backups.scheduled_for IS 'The schedule''s minute it runs for - unique, so each occurrence is queued once whatever the number of processes.';
COMMENT ON COLUMN totalbase.backups.destination IS 'Where its archive is written: LOCAL (backups.local_path) or S3 (the S3 storage connection, under backups/).';
COMMENT ON COLUMN totalbase.backups.name IS 'The archive''s file name - its key at the destination.';
COMMENT ON COLUMN totalbase.backups.manifest IS 'What the archive holds: TotalBase''s version, the migrations applied, PostgreSQL''s version, whether files are in it, the master key''s verifier.';
COMMENT ON COLUMN totalbase.backups.locked_at IS 'Renewed while it runs; a RUNNING backup whose lock went stale was interrupted and is marked FAILED, never run again.';
