import { TotalBaseError } from "@totalbase/errors";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { outboundFetch, outboundPolicy } from "./http-client.js";
import type { OperationHandler } from "./types.js";

/**
 * SOAP request (Specification_Workflows.md §5.15.1): one operation of a SOAP
 * 1.1 or 1.2 web service, the envelope built by the server from a JSON
 * object, the response's Body handed back as JSON, a Fault failing the
 * step. The exchange itself goes through the HTTP request step's outbound
 * client (http-client.ts): the same SSRF policy and
 * `workflows.http_allowed_hosts`, the same size limits, timeout and
 * cancellation. Nothing here is a second HTTP client.
 *
 * XML comes and goes through fast-xml-parser (the one XML dependency, and
 * the only consumer of it - AGENTS.md §24): the builder escapes `& < > " '`
 * in values, the parser decodes those five predefined entities and nothing
 * else - a response carrying a DOCTYPE (the only way to declare an entity,
 * the billion-laughs vector; SOAP forbids one) is refused before parsing.
 * Attributes are ignored both ways, namespace prefixes are dropped from
 * the response so a step reads `body.personaReturn.persona` whatever
 * prefix the service used.
 */

const SOAP_VERSIONS = {
  "1.1": { envelope: "http://schemas.xmlsoap.org/soap/envelope/", contentType: "text/xml; charset=utf-8" },
  "1.2": { envelope: "http://www.w3.org/2003/05/soap-envelope", contentType: "application/soap+xml; charset=utf-8" },
} as const;
type SoapVersion = keyof typeof SOAP_VERSIONS;

/** An XML element name as a configuration key may spell it: `Name`, `ns:Name` - never markup. */
const ELEMENT_NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/;

function invalid(message: string): TotalBaseError {
  return new TotalBaseError("WORKFLOW_INVALID_DESIGN", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The object a step configured, ready for the builder: element names checked
 * (a key is never markup), `null`/`undefined` leaves the element out, an array
 * repeats it. Dates become ISO strings; everything else is text.
 */
function toElements(value: unknown, path: string): unknown {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return value.map((item) => toElements(item, path)).filter((item) => item !== undefined);
  if (value instanceof Date) return value.toISOString();
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(value)) {
      if (!ELEMENT_NAME.test(name)) throw invalid(`"${path ? `${path}.` : ""}${name}" is not a valid XML element name.`);
      const converted = toElements(child, path ? `${path}.${name}` : name);
      if (converted !== undefined) out[name] = converted;
    }
    return out;
  }
  return String(value);
}

const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: "@_", suppressEmptyNode: false, processEntities: true });

/** The whole envelope: `<soap:Envelope>` with the namespace prefix `ns` bound to the operation's namespace. */
function buildEnvelope(version: SoapVersion, namespace: string, operation: string, body: unknown, headers: unknown): string {
  const envelope: Record<string, unknown> = {
    "@_xmlns:soap": SOAP_VERSIONS[version].envelope,
    "@_xmlns:ns": namespace,
  };
  if (headers !== undefined) envelope["soap:Header"] = headers;
  envelope["soap:Body"] = { [`ns:${operation}`]: body ?? "" };
  return `<?xml version="1.0" encoding="utf-8"?>${builder.build({ "soap:Envelope": envelope })}`;
}

/** The response, with every namespace prefix dropped; `arrays` names the elements that are always a list. */
function parser(arrays: string[]): XMLParser {
  const always = new Set(arrays);
  return new XMLParser({
    ignoreAttributes: true,
    removeNSPrefix: true,
    processEntities: true,
    htmlEntities: false,
    parseTagValue: true,
    numberParseOptions: { hex: false, leadingZeros: false, eNotation: false },
    isArray: (name) => always.has(name),
  });
}

interface SoapFault {
  code: string | null;
  message: string;
  detail: unknown;
}

/** A SOAP 1.1 (`faultcode`/`faultstring`/`detail`) or 1.2 (`Code.Value`/`Reason.Text`/`Detail`) Fault, as one shape. */
function readFault(fault: unknown): SoapFault {
  if (!isRecord(fault)) return { code: null, message: "the service answered a Fault", detail: fault ?? null };
  const text = (value: unknown): string | null => (typeof value === "string" || typeof value === "number" ? String(value) : null);
  const reason = isRecord(fault.Reason) ? fault.Reason.Text : undefined;
  const codeValue = isRecord(fault.Code) ? fault.Code.Value : undefined;
  return {
    code: text(fault.faultcode) ?? text(codeValue),
    message: text(fault.faultstring) ?? text(Array.isArray(reason) ? reason[0] : reason) ?? "the service answered a Fault",
    detail: fault.detail ?? fault.Detail ?? null,
  };
}

function requireText(configuration: Record<string, unknown>, field: string, what: string): string {
  const value = configuration[field];
  if (typeof value !== "string" || !value.trim()) throw invalid(`This step's ${what} must resolve to a non-empty string.`);
  return value.trim();
}

function requireObject(value: unknown, what: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw invalid(`This step's ${what} must resolve to an object.`);
  return value;
}

const soapRequest: OperationHandler = async ({ context, configuration, workflowContext }) => {
  const resolvedUrl = requireText(configuration, "url", "URL");
  let url: URL;
  try {
    url = new URL(resolvedUrl);
  } catch {
    throw invalid(`This step's URL is not a valid absolute URL: ${resolvedUrl}`);
  }
  const version = String(configuration.version ?? "1.1") as SoapVersion;
  if (!(version in SOAP_VERSIONS)) throw invalid(`This step's SOAP version must be 1.1 or 1.2.`);
  const operation = requireText(configuration, "operation", "operation");
  if (!ELEMENT_NAME.test(operation) || operation.includes(":")) throw invalid(`This step's operation is not a valid XML element name: ${operation}`);
  const namespace = requireText(configuration, "namespace", "namespace");
  const soapAction = typeof configuration.soapAction === "string" ? configuration.soapAction.trim() : "";
  const arrays = Array.isArray(configuration.arrays) ? configuration.arrays.filter((name): name is string => typeof name === "string" && name.trim() !== "").map((name) => name.trim()) : [];

  const body = toElements(requireObject(configuration.body, "body"), "body");
  const soapHeaders = toElements(requireObject(configuration.soapHeaders, "SOAP headers"), "soapHeaders");
  const httpHeaders = requireObject(configuration.httpHeaders, "HTTP headers") ?? {};
  const headers: Record<string, string> = {
    "content-type": SOAP_VERSIONS[version].contentType,
    // SOAP 1.1 requires the header, an empty one included; 1.2 carries the action in the media type.
    ...(version === "1.1" ? { soapaction: `"${soapAction}"` } : soapAction ? { "content-type": `${SOAP_VERSIONS[version].contentType}; action="${soapAction}"` } : {}),
  };
  for (const [name, value] of Object.entries(httpHeaders)) headers[name.toLowerCase()] = String(value);
  // A credential in a definition would be readable by every administrator: secret headers name a secret instead.
  for (const entry of Array.isArray(configuration.secretHeaders) ? configuration.secretHeaders as Array<{ name?: unknown; secret?: unknown }> : []) {
    if (typeof entry?.name !== "string" || !entry.name.trim() || typeof entry.secret !== "string" || !entry.secret) throw invalid("Every secret header needs a name and a secret.");
    headers[entry.name.trim().toLowerCase()] = await context.secrets.decrypt(entry.secret);
  }

  const payload = buildEnvelope(version, namespace, operation, body, soapHeaders);
  const [maxRequestBytes, maxResponseBytes, allowedHosts] = await Promise.all([
    context.settings.get("workflows.http_max_request_bytes"),
    context.settings.get("workflows.http_max_response_bytes"),
    context.settings.get("workflows.http_allowed_hosts"),
  ]);
  if (Buffer.byteLength(payload, "utf8") > maxRequestBytes) {
    throw new TotalBaseError("WORKFLOW_LIMIT_EXCEEDED", `This step's envelope is larger than ${maxRequestBytes} bytes (workflows.http_max_request_bytes) - nothing was sent.`);
  }

  const policy = outboundPolicy(allowedHosts);
  const started = Date.now();
  // What failed, without what was sent: no header values, no envelope.
  const diagnostics = (extra: Record<string, unknown>) => JSON.stringify({ operation, url: url.toString(), durationMs: Date.now() - started, ...extra });
  let response: Awaited<ReturnType<typeof outboundFetch>>;
  try {
    response = await outboundFetch({ method: "POST", url: url.toString(), headers, body: payload, timeoutMs: 30_000, signal: workflowContext.signal, maxResponseBytes }, policy);
  } catch (error) {
    if (error instanceof TotalBaseError) throw new TotalBaseError(error.code, error.message, { detail: diagnostics({}) });
    const reason = workflowContext.signal?.aborted ? "the run was cancelled" : error instanceof Error && error.name === "TimeoutError" ? "no answer within 30 seconds" : error instanceof Error ? error.message : "unknown error";
    throw new TotalBaseError("INTERNAL_ERROR", `SOAP request failed: ${reason}.`, { detail: diagnostics({}) });
  }
  const durationMs = Date.now() - started;
  const text = response.body.toString("utf8");

  // SOAP 1.1 and 1.2 both forbid a DTD; one here could only declare entities to expand.
  if (/<!DOCTYPE/i.test(text)) throw new TotalBaseError("INTERNAL_ERROR", "SOAP request returned a document with a DOCTYPE, which a SOAP message never has.", { detail: diagnostics({ status: response.status }) });
  let parsed: unknown;
  try {
    parsed = parser(arrays).parse(text);
  } catch {
    parsed = undefined;
  }
  const envelope = isRecord(parsed) ? parsed.Envelope : undefined;
  const soapBody = isRecord(envelope) && isRecord(envelope.Body) ? envelope.Body : undefined;
  if (soapBody === undefined) {
    throw new TotalBaseError("INTERNAL_ERROR", `SOAP request returned status ${response.status} without a SOAP envelope.`, { detail: diagnostics({ status: response.status, headers: response.headers, body: text.slice(0, 4096) }) });
  }
  if ("Fault" in soapBody) {
    const fault = readFault(soapBody.Fault);
    throw new TotalBaseError("WORKFLOW_SOAP_FAULT", `SOAP request failed: ${fault.message}${fault.code ? ` (${fault.code})` : ""}.`, { detail: diagnostics({ status: response.status, fault }) });
  }
  if (response.status < 200 || response.status > 299) {
    throw new TotalBaseError("INTERNAL_ERROR", `SOAP request returned status ${response.status}.`, { detail: diagnostics({ status: response.status, headers: response.headers, body: soapBody }) });
  }
  return { output: "next", result: { status: response.status, headers: response.headers, body: soapBody, durationMs } };
};

export const SOAP_HANDLERS: Record<string, OperationHandler> = {
  "totalbase.soap-request": soapRequest,
};
