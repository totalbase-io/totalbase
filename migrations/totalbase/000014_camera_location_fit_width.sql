-- A Camera and a Location have a width of their own too (DataViews.md §12.2): a button that takes a photo, a button
-- that reads the position. Placed at the default width, they fit their content now, as 000013 did for buttons.

UPDATE totalbase.dataviews_fields
SET grid_w = 0
WHERE kind = 'WIDGET'
  AND grid_w = 12
  AND widget IN ('TCamera', 'TGeolocation');
