-- An embed of one widget (Dashboards.md §9.5): `widget` names a widget of the
-- dashboard's published version; the embed then shows that card alone, sized to its frame. NULL is the
-- whole dashboard, as before. No foreign key: a published widget lives in the version's snapshot - a
-- widget the live version no longer has stops the embed (EMBED_NEEDS_UPDATE), it never falls back to
-- the whole dashboard.
ALTER TABLE totalbase.dashboards_embeds ADD COLUMN widget uuid;

COMMENT ON COLUMN totalbase.dashboards_embeds.widget IS 'The one widget it shows, by id in the published version; NULL = the whole dashboard. A widget the live version no longer has stops the embed.';
