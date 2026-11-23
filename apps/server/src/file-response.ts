import type { FastifyReply } from "fastify";

/**
 * The types a stored file is shown in place as (`inline`): pictures and PDF, which a browser renders without running
 * anything of the file's. They are exactly the signatures the upload recognizes (`@totalbase/files`' detectMimeType),
 * so a file claiming one of them that isn't one is still shown as that type - which `nosniff` keeps from becoming
 * anything else. Every other type - HTML, SVG, XML, JavaScript, text - is a download (Administration.md §10.5).
 */
const SHOWN_IN_PLACE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);

/**
 * A file's content as an answer, on the instance's own origin: what an uploader put in it never runs with a
 * visitor's session. Shown in place only for SHOWN_IN_PLACE, a download otherwise; and every answer but a PDF's
 * carries `Content-Security-Policy: sandbox` - a document opened from it, whatever it holds, has no scripts, no
 * same-origin access and no forms. A PDF goes without it (browsers refuse to show a PDF in a sandbox; their viewer
 * is a sandbox of its own). An `<img>`, `<video>` or `fetch()` reads either the same, from any site
 * (`Cross-Origin-Resource-Policy: cross-origin`): a public file is there to be shown elsewhere, a private one needs
 * the visitor's own credential anyway.
 */
export function sendFileContent(reply: FastifyReply, file: { mimeType: string; name: string }, content: Buffer): FastifyReply {
  const type = file.mimeType.toLowerCase().split(";")[0]!.trim();
  const inline = SHOWN_IN_PLACE.has(type);
  reply.header("content-type", file.mimeType);
  reply.header("content-disposition", `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(file.name)}"`);
  if (type !== "application/pdf") reply.header("content-security-policy", "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'");
  reply.header("cross-origin-resource-policy", "cross-origin");
  return reply.send(content);
}

/** A rendition the image transforms produced (a raster picture, always): shown in place, sandboxed, from any site. */
export function sendFileRendition(reply: FastifyReply, contentType: string, content: Buffer): FastifyReply {
  reply.header("content-type", contentType);
  reply.header("cross-origin-resource-policy", "cross-origin");
  reply.header("content-security-policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
  return reply.send(content);
}
