-- The App menu holds the delegated modules too (Security.md §8.2): a MODULE entry opens Users, Roles, Files,
-- Templates or Logs from the App's own menu - the standalone App shell has no rail to reach them from
-- (Admin_UI.md §3.1.1). Shown to a viewer by the same rule as the rail (Security.md §9.2): READ on the module's
-- table; never a grant of its own. Each module appears once; its label and icon are the entry's own (none: the
-- module's).

ALTER TABLE totalbase.menus ADD COLUMN module text;
COMMENT ON COLUMN totalbase.menus.module IS 'A MODULE entry''s module - users, roles, files, templates or logs; its name and icon override the module''s own.';

ALTER TABLE totalbase.menus DROP CONSTRAINT menus_kind_check;
ALTER TABLE totalbase.menus ADD CONSTRAINT menus_kind_check CHECK (kind = ANY (ARRAY['GROUP'::text, 'DATAVIEW'::text, 'DASHBOARD'::text, 'MODULE'::text]));

ALTER TABLE totalbase.menus ADD CONSTRAINT menus_module_check CHECK (module = ANY (ARRAY['users'::text, 'roles'::text, 'files'::text, 'templates'::text, 'logs'::text]));

ALTER TABLE totalbase.menus DROP CONSTRAINT menus_kind_shape;
ALTER TABLE totalbase.menus ADD CONSTRAINT menus_kind_shape CHECK (
     ((kind = 'GROUP'::text) AND (dataview IS NULL) AND (dashboard IS NULL) AND (module IS NULL) AND (name IS NOT NULL) AND (length(btrim(name)) > 0))
  OR ((kind = 'DATAVIEW'::text) AND (dataview IS NOT NULL) AND (dashboard IS NULL) AND (module IS NULL) AND (name IS NULL) AND (icon IS NULL) AND (icon_open IS NULL))
  OR ((kind = 'DASHBOARD'::text) AND (dashboard IS NOT NULL) AND (dataview IS NULL) AND (module IS NULL) AND (name IS NULL) AND (icon IS NULL) AND (icon_open IS NULL))
  OR ((kind = 'MODULE'::text) AND (module IS NOT NULL) AND (dataview IS NULL) AND (dashboard IS NULL) AND (icon_open IS NULL) AND (name IS NULL OR length(btrim(name)) > 0))
);

ALTER TABLE totalbase.menus ADD CONSTRAINT menus_module_key UNIQUE (module);

COMMENT ON TABLE totalbase.menus IS 'The App menu: groups and entries - a DataView, a dashboard or a delegated module - in order. Each user sees only the entries they may open.';
