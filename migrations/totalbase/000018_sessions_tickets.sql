-- Realtime tickets (Security.md §2.10, Data_API.md §16.3): a short-lived, single-use stand-in for a session, good
-- only to open a WebSocket from a browser on another host - whose session token lives in an HttpOnly cookie of
-- the application's own server and never reaches the page. Issued by POST /api/auth/realtime-ticket, consumed
-- by the first `auth` message (or graphql-transport-ws's connection_init); the connection is then the session's.
-- In PostgreSQL so every server process honours a ticket another issued. Only the hash is stored.

CREATE TABLE totalbase.sessions_tickets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session     uuid NOT NULL REFERENCES totalbase.sessions(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_tickets_expires_at_idx ON totalbase.sessions_tickets (expires_at);
COMMENT ON TABLE totalbase.sessions_tickets IS 'Realtime tickets: a session''s 60-second, single-use stand-in to open a WebSocket from a browser on another host (Security.md §2.10). Only the hash is stored; expired rows are purged by the retention job.';
