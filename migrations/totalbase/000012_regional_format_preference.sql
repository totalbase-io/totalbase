-- The regional format decides how dates and times read (Security.md §4.2, Admin_UI.md §14): the date-fns
-- patterns go - the instance's system.date_format/time_format/datetime_format and a user's date_format and
-- time_format - and each user may choose their own regional format, the instance's being the default.

DELETE FROM totalbase.settings WHERE key IN ('system.date_format', 'system.time_format', 'system.datetime_format');

ALTER TABLE totalbase.users DROP CONSTRAINT users_preferences_valid;

UPDATE totalbase.users SET preferences = preferences - 'date_format' - 'time_format'
WHERE preferences ?| ARRAY['date_format', 'time_format'];

ALTER TABLE totalbase.users ADD CONSTRAINT users_preferences_valid CHECK (
    jsonb_typeof(preferences) = 'object'
    AND (NOT preferences ? 'timezone' OR (jsonb_typeof(preferences -> 'timezone') = 'string'
        AND length(preferences ->> 'timezone') BETWEEN 1 AND 64))
);

-- A tag's shape (es-AR); the service checks it against REGIONAL_FORMATS, so adding one needs no migration.
ALTER TABLE totalbase.users ADD CONSTRAINT users_preferences_regional_format_valid CHECK (
    NOT preferences ? 'regional_format' OR (jsonb_typeof(preferences -> 'regional_format') = 'string'
        AND (preferences ->> 'regional_format') ~ '^[a-z]{2,3}-[A-Z]{2}$')
);

COMMENT ON COLUMN totalbase.users.preferences IS 'The user''s own display preferences (timezone, regional_format, language). A missing key = the instance default (system.* settings).';
