import { shapeErrors, type Shape } from "@totalbase/shared";
import { TotalBaseError } from "@totalbase/errors";

/**
 * Workflow definition limits (Workflows.md §3.6), checked on
 * every save - create, draft save, Save as - and again on publish, so a
 * definition written through the Admin API is bounded like one built in
 * the editor. The editor mirrors these values
 * (`apps/admin/app/utils/workflow-limits.ts`, kept equal by its test) to
 * refuse or warn before saving; the server stays the authority.
 *
 * The global request limits (`api.max_body_bytes`, ...) still apply first.
 */
export const WORKFLOW_DEFINITION_LIMITS = {
  /** Operations per workflow, Start included. */
  maxOperations: 100,
  maxConnections: 200,
  /** UTF-8 bytes of one operation's `JSON.stringify(configuration)`. */
  maxConfigurationBytes: 65_536,
  /** UTF-8 bytes of the whole serialized definition. */
  maxDefinitionBytes: 1_048_576,
  /** Levels of objects/arrays in a configuration, the configuration object itself being 1. */
  maxConfigurationDepth: 20,
  /** Keys of any one object in a configuration (Update records' `set`, HTTP headers, ...). */
  maxMapFields: 100,
  /** Characters of one template path, `{{path}}` (§4.1). */
  maxTemplatePathLength: 1_024,
} as const;

const EXPRESSION_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const encoder = new TextEncoder();

interface LimitedOperation {
  id?: unknown;
  key?: unknown;
  label?: unknown;
  configuration?: unknown;
}

function exceeded(message: string): never {
  throw new TotalBaseError("WORKFLOW_LIMIT_EXCEEDED", message);
}

function nameOf(op: LimitedOperation): string {
  if (typeof op.key === "string" && op.key) return `"${op.key}"`;
  if (typeof op.label === "string" && op.label) return `"${op.label}"`;
  return String(op.id);
}

const byteLength = (value: unknown): number => encoder.encode(JSON.stringify(value) ?? "").length;

/**
 * One operation's configuration as a shape (`@totalbase/tb-catalog`'s `shapeErrors`): a JSON value of any
 * form, bounded - never walked past the depth limit (so a pathologically deep value cannot exhaust the
 * stack), keys per object, and every string's template paths.
 */
const CONFIGURATION_SHAPE: Shape = {
  type: "any",
  maxDepth: WORKFLOW_DEFINITION_LIMITS.maxConfigurationDepth,
  maxKeys: WORKFLOW_DEFINITION_LIMITS.maxMapFields,
  text: {
    type: "custom",
    takes: "text",
    check: (value) => {
      for (const match of (value as string).matchAll(EXPRESSION_PATTERN)) {
        const length = match[1]!.length;
        if (length > WORKFLOW_DEFINITION_LIMITS.maxTemplatePathLength) return `has a template path of ${length} characters; the limit is ${WORKFLOW_DEFINITION_LIMITS.maxTemplatePathLength}`;
      }
      return null;
    },
  },
};

/** The limit each kind of refusal names. */
const LIMIT_NAMES = { depth: "configuration nesting depth", keys: "map fields per operation", check: "template path length" } as const;

function checkConfigurationShape(op: LimitedOperation): void {
  const issue = shapeErrors("configuration", CONFIGURATION_SHAPE, op.configuration)[0];
  if (issue) exceeded(`Step ${nameOf(op)}: ${issue.message.replace(/\.$/, "")} (${LIMIT_NAMES[issue.kind as keyof typeof LIMIT_NAMES] ?? issue.kind}).`);
}

/** Throws `WORKFLOW_LIMIT_EXCEEDED` (422) naming the limit and, when one is at fault, the operation. */
export function validateDefinitionLimits(definition: Record<string, unknown>): void {
  const limits = WORKFLOW_DEFINITION_LIMITS;
  const operations = Array.isArray(definition.operations) ? (definition.operations as unknown[]) : [];
  const connections = Array.isArray(definition.connections) ? definition.connections : [];
  if (operations.length > limits.maxOperations) {
    exceeded(`This workflow has ${operations.length} operations; the limit is ${limits.maxOperations}, Start included (operations per workflow).`);
  }
  if (connections.length > limits.maxConnections) {
    exceeded(`This workflow has ${connections.length} connections; the limit is ${limits.maxConnections} (connections per workflow).`);
  }
  for (const raw of operations) {
    if (typeof raw !== "object" || raw === null) continue; // the graph rules report it
    const op = raw as LimitedOperation;
    checkConfigurationShape(op);
    const bytes = byteLength(op.configuration ?? {});
    if (bytes > limits.maxConfigurationBytes) {
      exceeded(`Step ${nameOf(op)} has a configuration of ${bytes} bytes; the limit is ${limits.maxConfigurationBytes} (serialized configuration per operation).`);
    }
  }
  let bytes: number;
  try {
    bytes = byteLength(definition);
  } catch {
    exceeded(`This workflow's definition is nested too deeply to serialize (configuration nesting depth).`);
  }
  if (bytes > limits.maxDefinitionBytes) {
    exceeded(`This workflow's definition is ${bytes} bytes; the limit is ${limits.maxDefinitionBytes} (workflow definition size).`);
  }
}
