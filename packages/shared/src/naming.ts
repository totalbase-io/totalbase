import { TotalBaseError } from "@totalbase/errors";

/**
 * Shared `name`/`description`/`slug` validation and slug generation
 * (Foundations.md §9.3), reused by every table following the
 * convention: `dataviews`, `dashboards`, `workflows`, `templates`.
 */

const NAME_MAX_LENGTH = 32;
const DESCRIPTION_MAX_LENGTH = 128;
const SLUG_MAX_LENGTH = 32;

// Allow-list, not a deny-list: Unicode letters/numbers/combining marks, spaces and
// a title's ordinary punctuation ("VIP: actividad", "Ventas (2026)", "Altas & bajas").
// Everything else - control characters, path separators (`/`, `\`), and symbols
// such as `$ # ? % < > * |` - is rejected simply by not being in the allowed set.
const NAME_PUNCTUATION = "-_.,:;()'&+";
const NAME_ALLOWED_CHARACTER = /^[\p{L}\p{N}\p{M} \-_.,:;()'&+]$/u;

/** Foundations.md §9.3: required, trimmed, max 32 chars, Unicode letters/digits/separators only. */
export function validateName(raw: unknown): string {
  // A body without a name (or with a number there) is the caller's mistake, not a server error.
  if (typeof raw !== "string") throw new TotalBaseError("INVALID_NAME", "name is required");
  const name = raw.trim();
  if (name.length === 0) {
    throw new TotalBaseError("INVALID_NAME", "name must not be empty");
  }
  if (name.length > NAME_MAX_LENGTH) {
    throw new TotalBaseError("INVALID_NAME", `name must not exceed ${NAME_MAX_LENGTH} characters`);
  }
  const refused = [...name].find((character) => !NAME_ALLOWED_CHARACTER.test(character));
  if (refused !== undefined) {
    throw new TotalBaseError("INVALID_NAME", `name can't contain "${refused}" - letters, digits, spaces and ${NAME_PUNCTUATION.split("").join(" ")} only`);
  }
  return name;
}

/**
 * A DataView's or a dashboard's label in the App menu: optional, trimmed, max 32 chars like a name - any
 * printable text (punctuation is fine: it is only shown), never a control character. Empty: none (its name shows).
 */
export function validateMenuLabel(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const label = raw.trim();
  if (label.length === 0) return null;
  if (label.length > NAME_MAX_LENGTH) throw new TotalBaseError("INVALID_NAME", `menu label must not exceed ${NAME_MAX_LENGTH} characters`);
   
  if (/[\u0000-\u001f\u007f]/.test(label)) throw new TotalBaseError("INVALID_NAME", "menu label contains control characters");
  return label;
}

/** Foundations.md §9.3: optional free text, max 128 chars, trimmed. */
export function validateDescription(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const description = raw.trim();
  if (description.length === 0) return null;
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    throw new TotalBaseError(
      "INVALID_DESCRIPTION",
      `description must not exceed ${DESCRIPTION_MAX_LENGTH} characters`,
    );
  }
  return description;
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Foundations.md §9.3: lowercase ASCII letters/digits/hyphen only, max 32 chars. */
export function validateSlug(raw: string): string {
  const slug = raw.trim();
  if (slug.length === 0) {
    throw new TotalBaseError("INVALID_SLUG", "slug must not be empty");
  }
  if (slug.length > SLUG_MAX_LENGTH) {
    throw new TotalBaseError("INVALID_SLUG", `slug must not exceed ${SLUG_MAX_LENGTH} characters`);
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new TotalBaseError(
      "INVALID_SLUG",
      "slug must be lowercase ASCII letters, digits, and single hyphens, starting/ending alphanumeric",
    );
  }
  return slug;
}

/**
 * Proposes a valid slug from a display name (Foundations.md §9.3). This is a
 * convenience for the Admin UI/server defaults only - the caller must
 * still run the result through validateSlug (or accept a manually-edited
 * value) before persisting.
 */
export function slugify(rawName: string): string {
  const slug = rawName
    .trim()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[\s_]+/g, "-") // word separators -> hyphen
    .replace(/[^a-z0-9-]/g, "") // drop anything else
    .replace(/-+/g, "-") // collapse repeated hyphens
    .replace(/^-+|-+$/g, ""); // trim leading/trailing hyphens
  return slug.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, "");
}
