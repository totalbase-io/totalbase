-- Realtime subscriptions (Data_API.md §16): a table opts in with REALTIME in its exposure, beside the HTTP verbs.
-- The publication they replicate (totalbase_realtime) is not created here - it comes with the first table
-- exposing REALTIME, so a role without CREATE on the database installs as before.
COMMENT ON COLUMN totalbase.resources.exposed_methods IS 'What the Data API offers for this resource: HTTP verbs from {GET,POST,PATCH,DELETE}, and REALTIME (a table''s realtime subscriptions; needs GET and a single-column primary key). Empty: not exposed.';
