/**
 * File-signature (magic-byte) detection, ported from @totalbase/assets
 * (mime-detection.ts) - same rationale: must not trust only the client-
 * provided Content-Type on upload.
 *
 * Deliberately narrow: recognizes only the signatures below. An
 * unrecognized signature falls back to the declared Content-Type - a
 * known, documented limitation rather than a silent gap.
 */
export function detectMimeType(content: Buffer): string | undefined {
  if (startsWith(content, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(content, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(content, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])) return "image/gif"; // GIF87a
  if (startsWith(content, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return "image/gif"; // GIF89a
  if (
    startsWith(content, [0x52, 0x49, 0x46, 0x46]) && // "RIFF"
    content.length >= 12 &&
    content.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (startsWith(content, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // "%PDF-"
  return undefined;
}

function startsWith(buffer: Buffer, signature: number[]): boolean {
  if (buffer.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (buffer[i] !== signature[i]) return false;
  }
  return true;
}
