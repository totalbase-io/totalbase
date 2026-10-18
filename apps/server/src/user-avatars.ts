import { TotalBaseError } from "@totalbase/errors";
import { detectMimeType, readImageDimensions, transformImage } from "@totalbase/files";
import type { AppContext } from "./context.js";

/**
 * A user's avatar, stored through the Files module (same approach as
 * routes/files.ts: orchestration over @totalbase/files and the
 * users service, no storage of its own).
 *
 * An uploaded image is re-encoded to a square WebP of at most 256px -
 * center-cropped, never enlarged (transformImage doesn't upscale) - with
 * EXIF and other metadata stripped by the re-encode, and stored as a
 * PUBLIC file - an <img> can't send a bearer token; the URL carries an
 * unguessable id, the way GitHub's avatar URLs are public - in the root
 * "Avatars" folder, so avatars don't mix with a project's own files.
 * `users.avatar_url` then points at the public file route.
 *
 * Replacing or removing an avatar deletes the file it replaced - only
 * when that file lives in the Avatars folder, never a file someone picked
 * from their own library.
 */

const AVATAR_FOLDER = "Avatars";
const AVATAR_SIZE = 256;
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const FILE_URL = /^\/api\/totalbase\/table\/files\/([0-9a-f-]{36})$/i;

function fileUrl(id: string): string {
  return `/api/totalbase/table/files/${id}`;
}

/** The root "Avatars" folder - created on first use, atomically (its unique index decides). */
async function avatarFolderId(context: AppContext): Promise<string> {
  const { rows } = await context.database.query<{ id: string }>(
    `INSERT INTO totalbase.folders (parent, name) VALUES (NULL, $1)
     ON CONFLICT ((lower(name))) WHERE parent IS NULL DO UPDATE SET name = folders.name
     RETURNING id`,
    [AVATAR_FOLDER],
  );
  return rows[0]!.id;
}

/** Deletes the avatar file a change replaced - best-effort, an orphan file is not worth failing the change over. */
async function removeReplaced(context: AppContext, previous: string | null): Promise<void> {
  const id = previous?.match(FILE_URL)?.[1];
  if (!id) return;
  try {
    const [file, folder] = await Promise.all([context.filesAdmin.get(id), avatarFolderId(context)]);
    if (file.folder === folder) await context.filesAdmin.remove(id);
  } catch {
    // Already gone, or not ours - leave it.
  }
}

export async function uploadUserAvatar(context: AppContext, userId: string, content: Buffer, uploadedBy: string): Promise<string> {
  if (content.length === 0) throw new TotalBaseError("FILE_UPLOAD_REQUIRED", "An image is required.");
  if (content.length > AVATAR_MAX_BYTES) {
    throw new TotalBaseError("FILE_TOO_LARGE", `An avatar can be at most ${AVATAR_MAX_BYTES / (1024 * 1024)} MB.`);
  }
  const mimeType = detectMimeType(content);
  if (!mimeType || !AVATAR_TYPES.has(mimeType)) {
    throw new TotalBaseError("FILE_MIME_TYPE_NOT_ALLOWED", "An avatar must be a PNG, JPEG or WebP image.");
  }
  if (!(await context.auth.users.findById(userId))) throw new TotalBaseError("RESOURCE_NOT_FOUND", "User not found.");

  // Square even when the source is smaller than AVATAR_SIZE: its short side.
  const { width, height } = await readImageDimensions(content);
  const side = Math.min(AVATAR_SIZE, width ?? AVATAR_SIZE, height ?? AVATAR_SIZE);
  const image = await transformImage(content, { width: side, height: side, fit: "cover", format: "webp", quality: 85 }, 10_000);
  const file = await context.filesAdmin.upload({
    folder: await avatarFolderId(context),
    content: image.buffer,
    filename: `avatar-${userId}.webp`,
    declaredContentType: "image/webp",
    visibility: "PUBLIC",
    description: "User avatar",
    actorUserId: uploadedBy,
  });

  const url = fileUrl(file.id);
  let previous: string | null;
  try {
    ({ previous } = await context.auth.users.setAvatarUrl(userId, url));
  } catch (error) {
    await context.filesAdmin.remove(file.id).catch(() => undefined);
    throw error;
  }
  await removeReplaced(context, previous);
  return url;
}

/** "Use picture from <provider>": the picture of the user's most recently used OAuth identity. */
export async function useProviderAvatar(context: AppContext, userId: string): Promise<string> {
  const user = await context.auth.users.findForAdmin(userId);
  if (!user) throw new TotalBaseError("RESOURCE_NOT_FOUND", "User not found.");
  if (!user.providerAvatar) throw new TotalBaseError("RESOURCE_NOT_FOUND", "This user has no picture from a sign-in provider.");
  const { previous } = await context.auth.users.setAvatarUrl(userId, user.providerAvatar.url);
  await removeReplaced(context, previous);
  return user.providerAvatar.url;
}

export async function removeUserAvatar(context: AppContext, userId: string): Promise<void> {
  const { previous } = await context.auth.users.setAvatarUrl(userId, null);
  await removeReplaced(context, previous);
}

/** After a user is deleted: their uploaded avatar goes too. */
export async function removeDeletedUserAvatar(context: AppContext, avatarUrl: string | null): Promise<void> {
  await removeReplaced(context, avatarUrl);
}
