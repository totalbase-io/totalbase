-- A dashboard decides whether its viewers see the descriptions - each widget's ⓘ by its title and each
-- variable's ⓘ by its label (Dashboards.md §4.1, §10.5). Off, the descriptions stay as documentation (the
-- editor, the spec and the MCP guide still read them) without showing. Presentation, not content: applies at
-- once, never versioned, like the auto-refresh interval.

ALTER TABLE totalbase.dashboards ADD COLUMN show_descriptions boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN totalbase.dashboards.show_descriptions IS 'Whether viewers see the widgets'' and variables'' descriptions (an ⓘ); off, they stay as documentation.';
