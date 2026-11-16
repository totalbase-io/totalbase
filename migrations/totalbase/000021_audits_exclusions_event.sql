-- Event exclusions (Security.md §11.4): a column kept out of the audit log may be kept out of the outbox event
-- too - its payload and old payload, what webhooks and workflows receive - for a secret of the project's own
-- that no subscriber should be handed. Off by default: an event carries the whole row, as before.

ALTER TABLE totalbase.audits_exclusions ADD COLUMN event boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN totalbase.audits_exclusions.event IS 'Whether the column is also left out of the outbox event (payload and old payload) that webhooks and workflows receive; the event still names it among the changed columns.';
