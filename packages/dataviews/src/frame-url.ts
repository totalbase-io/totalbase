import { FRAME_URL_MAX_LENGTH, FRAME_URL_TOKEN, checkFrameUrl, checkFrameUrlTemplate } from "@totalbase/tb-catalog";
import { TotalBaseError } from "@totalbase/errors";

export { FRAME_URL_MAX_LENGTH };

/**
 * Validates an EXTERNALFRAME DataView's `view_config.frame_url`
 * (Specification_DataViews.md, "EXTERNALFRAME security") - the shared rule,
 * `checkFrameUrl` (@totalbase/tb-catalog). Returns the URL normalized by the
 * WHATWG parser (what the browser will load).
 */
export function validateFrameUrl(raw: unknown, ownOrigin?: string): string {
  const checked = checkFrameUrl(raw, ownOrigin);
  if ("problem" in checked) throw new TotalBaseError("DATAVIEW_FRAME_URL_INVALID", checked.problem);
  return checked.url;
}

/**
 * Validates a page Frame widget's URL template (Specification_DataViews.md §9.7):
 * its tokens are page values (`FRAME_URL_TOKEN` - `{{vars.*}}`,
 * `{{controls.*}}`, `{{slot.*}}`), the site written out before them
 * (`checkFrameUrlTemplate`). Empty is allowed. Returns the trimmed template.
 */
export function validateFrameUrlTemplate(raw: unknown, ownOrigin?: string): string {
  const checked = checkFrameUrlTemplate(raw, FRAME_URL_TOKEN, "{{vars.…}}, {{controls.…}} and {{slot.…}}", ownOrigin);
  if ("problem" in checked) throw new TotalBaseError("DATAVIEW_WIDGET_INVALID", checked.problem);
  return checked.template;
}
