-- A placed widget's width (DataViews.md §12.2): 1-12 columns of its row, or 0 - *Fit content* - for a widget with a
-- width of its own (a button, a badge, a switch: `fit` in the widget catalog). Until now every widget filled its
-- columns, so a button took a whole row; the ones placed at the default width now fit their content, as a new one
-- does. A width an author chose (a button at 6) is kept. Published versions keep their snapshot until republished.

ALTER TABLE totalbase.dataviews_fields ADD CONSTRAINT dataviews_fields_grid_w_range CHECK (grid_w BETWEEN 0 AND 12);

UPDATE totalbase.dataviews_fields
SET grid_w = 0
WHERE kind = 'WIDGET'
  AND grid_w = 12
  AND widget IN ('UButton', 'UBadge', 'UIcon', 'UAvatar', 'UUser', 'USwitch', 'UCheckbox', 'TQrCode', 'UPinInput', 'UInputRating', 'UDropdownMenu', 'UPopover', 'UTooltip');
