import { randomUUID } from "node:crypto";
import ivm from "isolated-vm";
import { getFunctionDetail } from "@totalbase/pg-catalog";
import { TotalBaseError } from "@totalbase/errors";
import { executeFunctionCall } from "@totalbase/mutations";
import { outboundFetch, outboundPolicy } from "./http-client.js";
import { resolveWorkflowResource } from "./resource-resolution.js";
import { workflowAuditCorrelation, type HandlerArgs, type OperationHandler } from "./types.js";

/**
 * Invokes a PostgreSQL function resource the way the Data API's FUNCTION
 * EXECUTE endpoint does - @totalbase/mutations' executeFunctionCall: the
 * EXECUTE permission check, compileFunctionCall, audit + outbox in one
 * transaction naming the acting user. `configuration.function` is a
 * resources.id (ExecuteFunctionModal.vue stores the picker's
 * `resource.id` directly), so this resolves by primary key rather than
 * by (schema, name) overload matching - the workflow editor's picker
 * already picked one concrete function, not an overload set.
 */
const executeFunction: OperationHandler = async ({ context, dataPrincipal, configuration, workflowContext }) => {
  const resource = await resolveWorkflowResource(context, configuration.function as string | undefined, ["FUNCTION"]);
  const resolvedArgs = configuration.arguments ?? {};
  if (typeof resolvedArgs !== "object" || resolvedArgs === null || Array.isArray(resolvedArgs)) {
    throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This step's arguments must resolve to an object.");
  }
  const args = resolvedArgs as Record<string, unknown>;
  const detail = await getFunctionDetail(context.database, resource.postgresOid);
  const value = await executeFunctionCall(
    context,
    dataPrincipal,
    resource,
    detail,
    args,
    { requestId: randomUUID(), source: "workflow", metadata: workflowAuditCorrelation(workflowContext) },
    new Date(),
  );
  return { output: "next", result: value };
};

/**
 * Runs raw SQL through @totalbase/sql-console's SqlConsoleService - the
 * one designated owner of admin-only raw SQL execution (AGENTS.md
 * section 6) - rather than a second, competing raw-execution path.
 * `executeAs` is required by ExecuteSqlModal.vue's own Save button, and
 * is for audit/history attribution only (see its own doc comment: "no
 * permission checks" - a decided product simplification, not a gap): the
 * statement runs as the connection's own PostgreSQL role either way.
 */
const executeSql: OperationHandler = async ({ context, dataPrincipal, configuration }) => {
  const statement = (configuration.statement as string | undefined)?.trim();
  if (!statement) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This step has no SQL statement configured.");
  const executeAs = (configuration.executeAs as string | undefined) ?? dataPrincipal.principal.id;
  if (!executeAs) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This step has no \"Execute as\" user configured.");
  const result = await context.sqlConsole.execute(executeAs, { sql: statement });
  return { output: "next", result: result.rows };
};

const EXECUTE_JAVASCRIPT_TIMEOUT_MS = 5_000;
/** V8 isolate heap cap (MiB) - small on purpose: a workflow step's own transformation logic, not a general-purpose compute job. */
const EXECUTE_JAVASCRIPT_MEMORY_LIMIT_MB = 32;

/**
 * One run's Execute JavaScript isolate (Workflows.md §5.8):
 * created by the first such step, kept on `RunState.sandbox` for the rest
 * of the run - a For each body's step runs its code once per item, and an
 * isolate (a whole V8 heap) is the expensive part - and disposed by the
 * engine when the run ends, however it ends. Each step still gets a fresh
 * context: nothing a step defines is visible to the next one. A script is
 * compiled once per distinct source and run in every step's own context.
 *
 * An isolate that hit its memory limit is disposed by V8 itself; the next
 * step notices and starts a new one instead of failing on a dead isolate.
 */
export class RunSandbox {
  private current: ivm.Isolate | null = null;
  private readonly scripts = new Map<string, ivm.Script>();

  isolate(): ivm.Isolate {
    if (!this.current || this.current.isDisposed) {
      this.scripts.clear();
      this.current = new ivm.Isolate({ memoryLimit: EXECUTE_JAVASCRIPT_MEMORY_LIMIT_MB });
    }
    return this.current;
  }

  async script(source: string): Promise<ivm.Script> {
    const isolate = this.isolate();
    let script = this.scripts.get(source);
    if (!script) {
      script = await isolate.compileScript(source);
      this.scripts.set(source, script);
    }
    return script;
  }

  dispose(): void {
    this.scripts.clear();
    if (this.current && !this.current.isDisposed) this.current.dispose();
    this.current = null;
  }
}

/**
 * What the script sees as `results`, copied into the isolate once: every
 * envelope by operation id, plus the by-key entries that are not the same
 * envelope again - `aliases` names the keys that are (key -> id), re-pointed
 * inside the isolate instead of copying each envelope a second time.
 * `start`'s envelope wraps the trigger data, which goes in as `trigger`
 * already: `startIsTrigger` rebuilds it in there too.
 */
function sandboxResults(state: HandlerArgs["state"]): { values: Record<string, unknown>; aliases: Record<string, string>; startIsTrigger: boolean } {
  const idOf = new Map<unknown, string>();
  const values: Record<string, unknown> = {};
  for (const [id, envelope] of state.results) {
    values[id] = envelope;
    idOf.set(envelope, id);
  }
  const aliases: Record<string, string> = {};
  let startIsTrigger = false;
  for (const [key, envelope] of state.resultsByKey) {
    const id = idOf.get(envelope);
    if (id !== undefined) aliases[key] = id;
    else if (key === "start" && envelope && typeof envelope === "object" && (envelope as { data?: unknown }).data === state.triggerData) startIsTrigger = true;
    else values[key] = envelope;
  }
  return { values, aliases, startIsTrigger };
}

/**
 * Runs the configured JavaScript in a genuinely separate V8 isolate
 * (`isolated-vm`, not `node:vm`) - its own heap, its own copies of every
 * built-in, no shared object graph or prototype chain with the host
 * process at all. `node:vm` (the prior implementation) only creates a new
 * *context* inside the SAME isolate/heap/process - Node's own docs are
 * explicit that this is not a security boundary ("it does not provide any
 * security guarantees... do not use it to run untrusted code"), which
 * `vm2` (the once-popular userland attempt to patch that with proxies/
 * prototype-scrubbing) never actually fixed either - it was discontinued
 * by its own maintainer in 2023 after repeated sandbox-escape CVEs, for
 * exactly that structural reason (still one shared V8 context underneath).
 * `isolated-vm` is what Directus itself migrated to for the same "Run
 * Script" use case, after a real vm2 sandbox-escape was reported against
 * Directus - the same category of product, the same category of feature.
 *
 * The isolate is the run's (`RunSandbox` above); the context is the
 * step's. Exposes exactly two values to the script, both copied INTO the
 * isolate (no live reference back to host objects): `trigger` (the run's
 * trigger data) and `results` (every already-executed operation's envelope,
 * keyed by operation id - `RunState.results` as the engine keeps it - and
 * by step key, as templates read them (`results.read_people.data`);
 * Workflows.md §5.8). No `fs`, no
 * network, no `process`, no `require` - none of that exists inside a
 * fresh isolate to begin with (this isn't an allowlist stripping anything
 * away - a new isolate simply never had them).
 *
 * The script's return value is deliberately round-tripped through
 * `JSON.stringify`/`JSON.parse` INSIDE the isolate before it's copied back
 * out - restricts a step's result to plain JSON data (objects/arrays/
 * strings/numbers/booleans/null), the same shape every other operation's
 * own `result` already has, rather than an arbitrary JS value (a
 * function, a class instance, a `Map`/`Set`) that couldn't be persisted
 * to `workflows_steps.result` or referenced via
 * `{{step.data...}}` (templates.ts) the same way as any other step's data
 * anyway - a value that wasn't already JSON-shaped, in practice, so this
 * makes an existing implicit constraint explicit and enforced.
 *
 * Timeout unchanged from the prior implementation (5s). Isolate memory
 * capped at 32 MiB - both hardcoded rather than settings-backed (no other
 * per-operation resource limit in the catalog is settings-configurable
 * either; `workflows.max_run_duration_ms` already bounds the WHOLE run).
 */
const executeJavascript: OperationHandler = async ({ configuration, state }) => {
  const code = (configuration.code as string | undefined) ?? "";
  const sandbox = (state.sandbox ??= new RunSandbox());
  let isolateContext: ivm.Context | undefined;
  try {
    let resultJson: string;
    try {
      isolateContext = await sandbox.isolate().createContext();
      const jail = isolateContext.global;
      const { values, aliases, startIsTrigger } = sandboxResults(state);
      await jail.set("trigger", new ivm.ExternalCopy(state.triggerData ?? null).copyInto());
      // By operation id, and by step key as templates read them (results.read_people.data) - a key is never uuid-shaped.
      await jail.set("results", new ivm.ExternalCopy(values).copyInto());
      await jail.set("__aliases", new ivm.ExternalCopy({ ...aliases, ...(startIsTrigger ? { start: "" } : {}) }).copyInto());
      // The by-key names re-pointed at the envelopes already in the isolate, before the author's code runs.
      const prelude = `for (const key in __aliases) results[key] = key === "start" && __aliases[key] === "" ? { data: trigger } : results[__aliases[key]]; delete globalThis.__aliases;`;
      const wrapped = `(function (trigger, results) {\n${code}\n})(trigger, results)`;
      const script = await sandbox.script(`${prelude} JSON.stringify((${wrapped}) ?? null)`);
      resultJson = await script.run(isolateContext, { timeout: EXECUTE_JAVASCRIPT_TIMEOUT_MS });
    } catch (error) {
      throw new TotalBaseError("INTERNAL_ERROR", error instanceof Error ? error.message : "JavaScript execution failed.");
    }
    let value: unknown;
    try {
      value = resultJson === undefined ? null : JSON.parse(resultJson);
    } catch {
      throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This step's result must be JSON-serializable data (no functions, class instances, or circular references).");
    }
    return { output: "next", result: value };
  } finally {
    // The step's context goes; the run's isolate stays for the next step (the engine disposes it when the run ends).
    if (isolateContext && !sandbox.isolate().isDisposed) isolateContext.release();
  }
};

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/**
 * Outbound HTTP (Workflows.md §5.15). `url`/`headers`/`body` are
 * literal JSON/text with `{{...}}` support, already resolved by the engine.
 * The destination is checked against the SSRF policy at connect time, every
 * redirect hop included (http-client.ts); `workflows.http_allowed_hosts`
 * exempts named hosts and ranges. `secretHeaders` take their values from
 * `totalbase.secrets` at run time - never stored in the definition or the
 * history. The request body and the response are bounded
 * (`workflows.http_max_request_bytes` / `_response_bytes`), a cancelled run
 * aborts the exchange, and a failure says what failed (`detail`: status, url,
 * duration).
 */
const httpRequest: OperationHandler = async ({ context, configuration, workflowContext }) => {
  const method = ((configuration.method as string | undefined) ?? "GET").toUpperCase();
  if (!HTTP_METHODS.has(method)) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", `This step's method must be one of ${[...HTTP_METHODS].join(", ")}.`);
  const resolvedUrl = configuration.url;
  if (typeof resolvedUrl !== "string" || !resolvedUrl) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This step's URL must resolve to a non-empty string.");
  let url: URL;
  try {
    url = new URL(resolvedUrl);
  } catch {
    throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", `This step's URL is not a valid absolute URL: ${resolvedUrl}`);
  }
  const resolvedHeaders = configuration.headers ?? {};
  if (typeof resolvedHeaders !== "object" || resolvedHeaders === null || Array.isArray(resolvedHeaders)) {
    throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This step's headers must resolve to an object.");
  }
  const headers = Object.fromEntries(Object.entries(resolvedHeaders as Record<string, unknown>).map(([name, value]) => [name, String(value)]));
  // A credential in a definition would be readable by every administrator: secret headers name a secret instead.
  for (const entry of Array.isArray(configuration.secretHeaders) ? configuration.secretHeaders as Array<{ name?: unknown; secret?: unknown }> : []) {
    if (typeof entry?.name !== "string" || !entry.name.trim() || typeof entry.secret !== "string" || !entry.secret) {
      throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "Every secret header needs a name and a secret.");
    }
    headers[entry.name.trim()] = await context.secrets.decrypt(entry.secret);
  }
  const body = configuration.body;
  const includeBody = body !== undefined && method !== "GET" && method !== "DELETE" && method !== "HEAD" && method !== "OPTIONS";
  if (includeBody && !Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
  const payload = includeBody ? JSON.stringify(body) : undefined;
  const [maxRequestBytes, maxResponseBytes, allowedHosts] = await Promise.all([
    context.settings.get("workflows.http_max_request_bytes"),
    context.settings.get("workflows.http_max_response_bytes"),
    context.settings.get("workflows.http_allowed_hosts"),
  ]);
  if (payload !== undefined && Buffer.byteLength(payload, "utf8") > maxRequestBytes) {
    throw new TotalBaseError("WORKFLOW_LIMIT_EXCEEDED", `This step's body is larger than ${maxRequestBytes} bytes (workflows.http_max_request_bytes) - nothing was sent.`);
  }

  const policy = outboundPolicy(allowedHosts);
  const started = Date.now();
  // What failed, without what was sent: no header values, no body.
  const diagnostics = (extra: Record<string, unknown>) => JSON.stringify({ method, url: url.toString(), durationMs: Date.now() - started, ...extra });
  let response: Awaited<ReturnType<typeof outboundFetch>>;
  try {
    response = await outboundFetch({ method, url: url.toString(), headers, body: payload, timeoutMs: 30_000, signal: workflowContext.signal, maxResponseBytes }, policy);
  } catch (error) {
    if (error instanceof TotalBaseError) throw new TotalBaseError(error.code, error.message, { detail: diagnostics({}) });
    const reason = workflowContext.signal?.aborted ? "the run was cancelled" : error instanceof Error && error.name === "TimeoutError" ? "no answer within 30 seconds" : error instanceof Error ? error.message : "unknown error";
    throw new TotalBaseError("INTERNAL_ERROR", `HTTP request failed: ${reason}.`, { detail: diagnostics({}) });
  }
  const durationMs = Date.now() - started;

  const contentType = response.headers["content-type"] ?? "";
  const text = response.body.toString("utf8");
  let responseBody: unknown = text;
  if (contentType.includes("application/json")) {
    try {
      responseBody = JSON.parse(text);
    } catch {
      responseBody = null;
    }
  }
  const result = { status: response.status, headers: response.headers, body: responseBody, durationMs };
  if (response.status < 200 || response.status > 299) throw new TotalBaseError("INTERNAL_ERROR", `HTTP request returned status ${response.status}.`, { detail: diagnostics({ status: response.status, headers: response.headers, body: responseBody }) });
  return { output: "next", result };
};

export const CODE_HANDLERS: Record<string, OperationHandler> = {
  "totalbase.execute-function": executeFunction,
  "totalbase.execute-sql": executeSql,
  "totalbase.execute-javascript": executeJavascript,
  "totalbase.http-request": httpRequest,
};
