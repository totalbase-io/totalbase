-- A file's visibility gains LINKED: reached by its uploader and by whoever may read a row that references it
-- (Administration.md §10.6). PRIVATE now means its uploader only - the rule is applied by TotalBase as SQL in every
-- read of totalbase.files (files-visibility.ts), not by this column alone.
ALTER TABLE totalbase.files DROP CONSTRAINT files_visibility_check;
ALTER TABLE totalbase.files ADD CONSTRAINT files_visibility_check CHECK (visibility IN ('PRIVATE', 'LINKED', 'PUBLIC'));

COMMENT ON COLUMN totalbase.files.visibility IS 'Who may reach the file: PRIVATE its uploader, LINKED also whoever reads a row that references it, PUBLIC anyone (Administration.md §10.6).';
