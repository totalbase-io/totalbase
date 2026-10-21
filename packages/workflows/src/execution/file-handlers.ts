import { TotalBaseError } from "@totalbase/errors";
import { assertFileCreateAllowed, assertFileReadAllowed, type DataPrincipal } from "@totalbase/mutations";
import { parseCsv, stringifyCsv } from "./csv.js";
import type { WorkflowEngineContext } from "./context.js";
import type { OperationHandler } from "./types.js";

/**
 * The file operations act as the run's executor, under the same rule as the
 * Files API (Workflows.md §5.20, Administration.md
 * §10.3): a PUBLIC file is readable by anyone, any other needs READ on
 * files within the grant's row filter; creating needs CREATE. An
 * administrator executor resolves full access. The file is authorized
 * before its content is read from storage.
 */
async function readAuthorizedContent(context: WorkflowEngineContext, dataPrincipal: DataPrincipal, fileId: string) {
  const file = await context.filesAdmin.get(fileId);
  await assertFileReadAllowed(context, dataPrincipal, file);
  return context.filesAdmin.readContent(file.id);
}

/** Reads an existing File's raw content (base64, since it may be binary) plus its stored metadata. `asset` is a literal string with `{{operation.data...}}` support (e.g. `{{create_file.data.asset}}`, a preceding Create file step's own `asset` output), already resolved by the time it reaches here (engine.ts's own `TEMPLATED_OPERATION_TYPES`) - ReadFileModal.vue's own doc comment. */
const readFile: OperationHandler = async ({ context, dataPrincipal, configuration }) => {
  const fileId = configuration.asset;
  if (typeof fileId !== "string" || !fileId) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This step's asset must resolve to a non-empty string.");
  const { file, content } = await readAuthorizedContent(context, dataPrincipal, fileId);
  return {
    output: "next",
    result: { name: file.name, filename: file.name, mimeType: file.mime_type, size: file.size_bytes, content: content.toString("base64") },
  };
};

/** `content` is a literal string with `{{operation.data.field}}` support, already resolved by the time it reaches here (engine.ts's own `TEMPLATED_OPERATION_TYPES`) - must resolve to a string, since it's written to the File verbatim. */
/**
 * `encoding` says how `content` is written: `text` (the default, stored as
 * UTF-8) or `base64` - binary content another step produced, e.g. Generate
 * PDF's `{{pdf.data.content}}`, decoded before storing. `folder` is a
 * folders id (a `{{...}}` template too); none stores at the root.
 */
const createFile: OperationHandler = async ({ context, dataPrincipal, configuration }) => {
  const name = (configuration.name as string | undefined)?.trim();
  const contentType = (configuration.contentType as string | undefined) || "text/plain";
  const content = configuration.content ?? "";
  const encoding = configuration.encoding ?? "text";
  const folder = configuration.folder || null;
  if (typeof content !== "string") throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This step's content must resolve to a string.");
  if (!name) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This step has no file name configured.");
  if (encoding !== "text" && encoding !== "base64") throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This step's encoding must be text or base64.");
  if (encoding === "base64" && !/^[A-Za-z0-9+/]*={0,2}$/.test(content.replace(/\s/g, ""))) {
    throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This step's content is not valid base64.");
  }
  if (folder !== null && typeof folder !== "string") throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This step's folder must resolve to a folder id.");
  await assertFileCreateAllowed(context, dataPrincipal);
  const file = await context.filesAdmin.upload({
    folder,
    content: Buffer.from(content, encoding === "base64" ? "base64" : "utf8"),
    filename: name,
    declaredContentType: contentType,
    // The executor's user (a token's owner, not the token) - §5.18.
    actorUserId: dataPrincipal.actorUserId ?? undefined,
  });
  return { output: "next", result: { asset: file.id, name: file.name, mimeType: file.mime_type, size: file.size_bytes } };
};

/** `asset` is a literal string with `{{...}}` support - see `readFile`'s own doc comment. */
const parseFile: OperationHandler = async ({ context, dataPrincipal, configuration }) => {
  const fileId = configuration.asset;
  const format = (configuration.format as "csv" | "json" | undefined) ?? "json";
  if (typeof fileId !== "string" || !fileId) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This step's asset must resolve to a non-empty string.");
  const { content } = await readAuthorizedContent(context, dataPrincipal, fileId);
  const text = content.toString("utf8");
  try {
    const result = format === "csv" ? parseCsv(text) : JSON.parse(text);
    return { output: "next", result };
  } catch (error) {
    throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", `Failed to parse asset as ${format}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

/** Serializes `data` (a literal JSON value with `{{...}}` support, already resolved) to csv/json text - GenerateFileModal.vue has no asset-name field, so this only produces content (e.g. for a later step, Create file, or Send email attachment), it doesn't itself persist an Asset. */
const generateFile: OperationHandler = async ({ configuration }) => {
  const format = (configuration.format as "csv" | "json" | undefined) ?? "json";
  const data = configuration.data;
  const content = format === "csv" ? stringifyCsv(Array.isArray(data) ? (data as Record<string, unknown>[]) : []) : JSON.stringify(data ?? null);
  return { output: "next", result: { format, content } };
};

export const FILE_HANDLERS: Record<string, OperationHandler> = {
  "totalbase.read-file": readFile,
  "totalbase.create-file": createFile,
  "totalbase.parse-file": parseFile,
  "totalbase.generate-file": generateFile,
};
