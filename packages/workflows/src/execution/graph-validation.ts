import { TotalBaseError } from "@totalbase/errors";
import { operationDefinition, operationOutputs } from "@totalbase/tb-catalog";
import { shapeErrors } from "@totalbase/shared";

/**
 * The definition's graph rules (Specification_Workflows.md §3.3, §3.4),
 * checked on every save and again on publish - the same rules the editor
 * keeps by construction, so a definition written through the Admin API
 * cannot be malformed either - and each step's configuration against its
 * shape in the operation catalog (`@totalbase/tb-catalog`, §5.25): no field
 * its type doesn't have, no value of the wrong kind. Completeness is not
 * checked here: an incomplete step is valid draft content (§3.5).
 *
 * Every violation is `WORKFLOW_INVALID_DESIGN`, its message naming the
 * operation.
 */

interface GraphOperation {
  id: string;
  type: string;
  key?: unknown;
  label?: unknown;
  parent?: unknown;
  configuration?: Record<string, unknown>;
}
interface GraphConnection {
  source: string;
  target: string;
  output: string;
}

/** Keys templates reserve (§4.1, §4.4): `start` is Start's own, `item` the current loop element, `error` the handled error. */
const RESERVED_KEYS = new Set(["start", "item", "error"]);

function invalid(message: string): never {
  throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", message);
}

/** How an operation is named in an error: its step key, else its label, else its id. */
function nameOf(op: GraphOperation): string {
  if (typeof op.key === "string" && op.key) return `"${op.key}"`;
  if (typeof op.label === "string" && op.label) return `"${op.label}"`;
  return op.id;
}

/** The output ports of an operation (§3.3) - the catalog's; a type TotalBase doesn't have keeps `next` and `error` until publish refuses it. */
export function outputPortsOf(op: Pick<GraphOperation, "type" | "configuration">): Set<string> {
  return new Set(operationOutputs(op.type, op.configuration) ?? ["next", "error"]);
}

/** A loop's body entry port (§3.4), or undefined for any other operation. */
const bodyOutputOf = (type: string): string | undefined => operationDefinition(type)?.bodyOutput;

export function validateWorkflowGraph(definition: Record<string, unknown>): void {
  if (!Array.isArray(definition.operations) || !Array.isArray(definition.connections)) {
    invalid("Workflow definition requires operations and connections arrays.");
  }

  const operations: GraphOperation[] = [];
  const byId = new Map<string, GraphOperation>();
  const keys = new Map<string, GraphOperation>();
  for (const raw of definition.operations as unknown[]) {
    if (typeof raw !== "object" || raw === null) invalid("Every operation must be an object.");
    const op = raw as GraphOperation;
    if (typeof op.id !== "string" || !op.id) invalid("Every operation needs a string `id`.");
    if (typeof op.type !== "string" || !op.type) invalid(`Operation ${op.id} needs a string \`type\`.`);
    if (op.configuration !== undefined && (typeof op.configuration !== "object" || op.configuration === null || Array.isArray(op.configuration))) {
      invalid(`Operation ${nameOf(op)} has a configuration that is not an object.`);
    }
    if (byId.has(op.id)) invalid(`Operation id ${op.id} is used twice.`);
    byId.set(op.id, op);
    operations.push(op);
    if (typeof op.key === "string" && op.key) {
      if (op.type === "totalbase.start" ? op.key !== "start" : RESERVED_KEYS.has(op.key)) {
        invalid(op.type === "totalbase.start" ? `The Start operation's key must be "start".` : `Operation ${nameOf(op)}: "${op.key}" is a reserved step key.`);
      }
      const clash = keys.get(op.key);
      if (clash) invalid(`Operations ${clash.id} and ${op.id} share the step key "${op.key}".`);
      keys.set(op.key, op);
    }
  }

  const starts = operations.filter((op) => op.type === "totalbase.start");
  if (starts.length !== 1) invalid("Workflow definition requires exactly one Start operation.");
  const start = starts[0]!;

  // Connections: existing ends, a valid port of the source, one target per
  // output, one incoming connection per operation, nothing into Start.
  const outgoing = new Map<string, GraphConnection[]>();
  const incoming = new Map<string, GraphConnection>();
  const usedPorts = new Set<string>();
  for (const raw of definition.connections as unknown[]) {
    if (typeof raw !== "object" || raw === null) invalid("Every connection must be an object.");
    const connection = raw as GraphConnection;
    if (typeof connection.source !== "string" || typeof connection.target !== "string" || typeof connection.output !== "string") {
      invalid("Every connection needs string `source`, `target` and `output`.");
    }
    const source = byId.get(connection.source);
    const target = byId.get(connection.target);
    if (!source) invalid(`A connection starts at operation ${connection.source}, which does not exist.`);
    if (!target) invalid(`Operation ${nameOf(source)}'s "${connection.output}" output points at operation ${connection.target}, which does not exist.`);
    if (!outputPortsOf(source).has(connection.output)) {
      invalid(`Operation ${nameOf(source)} has no "${connection.output}" output.`);
    }
    const port = `${connection.source}\u0000${connection.output}`;
    if (usedPorts.has(port)) invalid(`Operation ${nameOf(source)}'s "${connection.output}" output is connected more than once.`);
    usedPorts.add(port);
    if (target.id === start.id) invalid("The Start operation cannot have an incoming connection.");
    if (target.id === source.id) invalid(`Operation ${nameOf(source)} is connected to itself.`);
    if (incoming.has(target.id)) invalid(`Operation ${nameOf(target)} has more than one incoming connection.`);
    incoming.set(target.id, connection);
    outgoing.set(source.id, [...(outgoing.get(source.id) ?? []), connection]);
  }

  // No cycles: with at most one incoming connection each, a cycle is a
  // chain of predecessors that comes back to where it began.
  for (const op of operations) {
    const seen = new Set<string>([op.id]);
    let current = incoming.get(op.id)?.source;
    while (current !== undefined) {
      if (current === op.id) invalid(`Operation ${nameOf(op)} is part of a cycle.`);
      if (seen.has(current)) break; // a cycle further up, reported from one of its own members
      seen.add(current);
      current = incoming.get(current)?.source;
    }
  }

  // One loop scope at a time (§3.4): no loop inside another loop's body -
  // by the `parent` bookkeeping and by the graph itself (everything
  // reachable from the body output).
  const loopIds = new Set(operations.filter((op) => bodyOutputOf(op.type)).map((op) => op.id));
  for (const op of operations) {
    if (loopIds.has(op.id) && typeof op.parent === "string" && loopIds.has(op.parent)) {
      invalid(`Loop operation ${nameOf(op)} cannot be placed inside another loop operation's body.`);
    }
  }
  for (const loopId of loopIds) {
    const loop = byId.get(loopId)!;
    const bodyEntry = (outgoing.get(loopId) ?? []).find((c) => c.output === bodyOutputOf(loop.type))?.target;
    const queue = bodyEntry ? [bodyEntry] : [];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      if (loopIds.has(id)) invalid(`Loop operation ${nameOf(byId.get(id)!)} cannot be placed inside the body of loop operation ${nameOf(loop)}.`);
      for (const c of outgoing.get(id) ?? []) queue.push(c.target);
    }
  }

  // Each step's configuration against its type's shape - every problem at once, one line each.
  const problems = operations.flatMap((op) => {
    const definition = operationDefinition(op.type);
    return definition ? shapeErrors("configuration", definition.configuration, op.configuration ?? {}).map((issue) => `Operation ${nameOf(op)}: ${issue.message}`) : [];
  });
  if (problems.length > 0) invalid(problems.join("\n"));
}
