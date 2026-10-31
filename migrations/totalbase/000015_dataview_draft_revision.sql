-- A DataView's updated_at is its draft's revision (DataViews.md §2.1): every write of the draft moves it, its
-- fields' included - a widget placed, changed, moved or removed, a column added - so a designer open elsewhere
-- can tell the draft changed under it (§12.6). The package's own writes to totalbase.dataviews already set it;
-- the fields' writes do through this trigger, in the same transaction, whoever makes them.

CREATE OR REPLACE FUNCTION totalbase.touch_dataview() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE totalbase.dataviews SET updated_at = now() WHERE id = COALESCE(NEW.dataview, OLD.dataview);
  RETURN NULL;
END;
$$;
COMMENT ON FUNCTION totalbase.touch_dataview() IS 'Moves a DataView''s updated_at - its draft''s revision - when one of its fields is written.';

CREATE TRIGGER dataviews_fields_touch_dataview
  AFTER INSERT OR UPDATE OR DELETE ON totalbase.dataviews_fields
  FOR EACH ROW EXECUTE FUNCTION totalbase.touch_dataview();
