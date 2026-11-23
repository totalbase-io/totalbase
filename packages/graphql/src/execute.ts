import {
  execute,
  subscribe,
  getNamedType,
  GraphQLError,
  isObjectType,
  Kind,
  parse,
  specifiedRules,
  validate,
  type DocumentNode,
  type ExecutionArgs,
  type ExecutionResult,
  type OperationTypeNode,
  type FragmentDefinitionNode,
  type GraphQLObjectType,
  type GraphQLSchema,
  type OperationDefinitionNode,
  type SelectionSetNode,
} from "graphql";
import { TotalBaseError } from "@totalbase/errors";
import type { GraphQLExecutionContext } from "./schema.js";
import { Batcher } from "./translate.js";

export interface GraphQLLimits {
  /** graphql.max_calls: Data API calls per operation - a root field, a one-to-many field (one each, however many rows). */
  maxCalls: number;
  /** graphql.max_depth: how deep a selection nests, introspection included. */
  maxDepth: number;
  /** graphql.max_fields: the fields an operation selects, each fragment's once for every place it is spread. */
  maxFields: number;
}

export interface GraphQLResponse {
  status: number;
  body: { data?: unknown; errors?: Record<string, unknown>[] };
}

/**
 * One GraphQL-over-HTTP request (Data_API.md §17.1, §17.8, §17.9): `{ query, variables, operationName }` in,
 * `{ data, errors }` out. A request that doesn't parse, validate or meet the limits is 400 and runs nothing;
 * one that runs is 200, an error per root field that failed carrying the TotalBase code and the status REST
 * would answer. `unexpected` sees what is not a TotalBaseError (logged; answered as INTERNAL_ERROR).
 */
export async function executeGraphQL(
  schema: GraphQLSchema,
  body: unknown,
  context: GraphQLExecutionContext,
  limits: GraphQLLimits,
  unexpected: (error: unknown) => void,
): Promise<GraphQLResponse> {
  const prepared = prepare(schema, body, limits, unexpected);
  if ("refused" in prepared) return prepared.refused;
  if (prepared.operation === "subscription") {
    return refused(new TotalBaseError("INVALID_QUERY", "A subscription runs over the WebSocket at /api/graphql (graphql-transport-ws)."));
  }
  const result = await execute({ ...prepared.args, contextValue: { ...context, batcher: new Batcher() } });
  return responseOf(result, unexpected);
}

/**
 * A subscription operation (Data_API.md §17.7): prepared as a request is, then graphql-js's subscribe - one
 * response body per event until the iterator returns. Any other operation runs once, as a single response.
 */
export async function subscribeGraphQL(
  schema: GraphQLSchema,
  body: unknown,
  context: GraphQLExecutionContext,
  limits: GraphQLLimits,
  unexpected: (error: unknown) => void,
): Promise<GraphQLResponse | AsyncGenerator<GraphQLResponse["body"], void, void>> {
  const prepared = prepare(schema, body, limits, unexpected);
  if ("refused" in prepared) return prepared.refused;
  const contextValue = { ...context, batcher: new Batcher() };
  if (prepared.operation !== "subscription") return responseOf(await execute({ ...prepared.args, contextValue }), unexpected);
  const stream = await subscribe({ ...prepared.args, contextValue });
  if (!(Symbol.asyncIterator in stream)) return responseOf(stream, unexpected);
  return (async function* () {
    try {
      for await (const result of stream) yield responseOf(result, unexpected).body;
    } finally {
      await stream.return?.();
    }
  })();
}

/**
 * The operation a request would run - query, mutation or subscription - parsed only, for what depends on it
 * before running (an Idempotency-Key applies to a mutation); undefined for one that doesn't parse or pick one.
 */
export function operationTypeOf(body: unknown): OperationTypeNode | undefined {
  const { query, operationName } = (body ?? {}) as Record<string, unknown>;
  if (typeof query !== "string") return undefined;
  try {
    const operations = parse(query, { maxTokens: MAX_TOKENS }).definitions.filter((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION);
    const operation = typeof operationName === "string" ? operations.find((o) => o.name?.value === operationName) : operations.length === 1 ? operations[0] : undefined;
    return operation?.operation;
  } catch {
    return undefined;
  }
}

/**
 * A document's most tokens: past them parsing stops - a GraphQL request is a query, never a megabyte of one (a full
 * introspection query is well under 1,000). graphql-js' own validation (overlapping fields) grows with the square
 * of a document's size, so this bounds it too.
 */
const MAX_TOKENS = 10_000;

/** What a request asks, parsed, validated and within the limits - or the 400 it gets, running nothing. */
function prepare(
  schema: GraphQLSchema,
  body: unknown,
  limits: GraphQLLimits,
  unexpected: (error: unknown) => void,
): { refused: GraphQLResponse } | { args: Omit<ExecutionArgs, "contextValue">; operation: OperationTypeNode | undefined } {
  const { query, variables, operationName } = (body ?? {}) as Record<string, unknown>;
  if (typeof query !== "string" || query.length === 0) return { refused: refused(new TotalBaseError("INVALID_QUERY", "query must be a GraphQL document.")) };
  if (variables !== undefined && variables !== null && (typeof variables !== "object" || Array.isArray(variables))) {
    return { refused: refused(new TotalBaseError("INVALID_QUERY", "variables must be an object.")) };
  }
  if (operationName !== undefined && operationName !== null && typeof operationName !== "string") {
    return { refused: refused(new TotalBaseError("INVALID_QUERY", "operationName must be a string.")) };
  }

  let document: DocumentNode;
  try {
    document = parse(query, { maxTokens: MAX_TOKENS });
  } catch (error) {
    return { refused: { status: 400, body: { errors: [formatError(error as GraphQLError, unexpected)] } } };
  }
  const validationErrors = validate(schema, document, specifiedRules);
  if (validationErrors.length > 0) return { refused: { status: 400, body: { errors: validationErrors.map((error) => formatError(error, unexpected)) } } };

  let operation: OperationDefinitionNode | undefined;
  try {
    operation = assertLimits(schema, document, operationName ?? undefined, limits);
  } catch (error) {
    return { refused: refused(error as TotalBaseError) };
  }
  return {
    operation: operation?.operation,
    args: {
      schema,
      document,
      variableValues: (variables ?? undefined) as Record<string, unknown> | undefined,
      operationName: (operationName ?? undefined) as string | undefined,
    },
  };
}

function responseOf(result: ExecutionResult, unexpected: (error: unknown) => void): GraphQLResponse {
  const errors = result.errors?.map((error) => formatError(error, unexpected));
  // No data at all: the request never ran (an unknown operation, a variable that doesn't coerce).
  if (!("data" in result) || result.data === undefined) return { status: 400, body: { errors: errors ?? [] } };
  return { status: 200, body: { data: result.data, ...(errors && { errors }) } };
}

function refused(error: TotalBaseError): GraphQLResponse {
  return { status: error.httpStatus, body: { errors: [{ message: error.message, extensions: extensionsOf(error) }] } };
}

function extensionsOf(error: TotalBaseError): Record<string, unknown> {
  const { message: _message, ...rest } = error.toPublicJSON();
  return { ...rest, status: error.httpStatus };
}

function formatError(error: GraphQLError, unexpected: (error: unknown) => void): Record<string, unknown> {
  const located = {
    ...(error.locations && { locations: error.locations }),
    ...(error.path && { path: error.path }),
  };
  const original = error.originalError;
  if (original instanceof TotalBaseError) return { message: original.message, ...located, extensions: extensionsOf(original) };
  if (original && !(original instanceof GraphQLError)) {
    unexpected(original);
    return { message: "Internal server error.", ...located, extensions: { source: "TOTALBASE", code: "INTERNAL_ERROR", status: 500 } };
  }
  // GraphQL's own: a syntax or validation error, a value that doesn't coerce.
  return { message: error.message, ...located, extensions: { source: "TOTALBASE", code: "INVALID_QUERY", status: 400 } };
}

/** graphql.max_calls, graphql.max_depth and graphql.max_fields, on the operation that would run, fragments followed. */
function assertLimits(schema: GraphQLSchema, document: DocumentNode, operationName: string | undefined, limits: GraphQLLimits): OperationDefinitionNode | undefined {
  const operations = document.definitions.filter((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION);
  const operation = operationName ? operations.find((o) => o.name?.value === operationName) : operations.length === 1 ? operations[0] : undefined;
  if (!operation) return undefined; // execute() answers it
  const fragments = new Map(
    document.definitions.filter((d): d is FragmentDefinitionNode => d.kind === Kind.FRAGMENT_DEFINITION).map((f) => [f.name.value, f]),
  );

  // Each field the schema marks as a Data API call (DATA_API_CALL), wherever it sits; validation already made
  // every field exist on its type. A named fragment is counted once per type and its count reused: walking it
  // again at every spread made a chain of fragments that each spread the one before twice cost 2^n - a 2 KB
  // document blocked the process before any limit answered (Data_API.md §17.8).
  const fragmentCalls = new Map<string, number>();
  const calls = (set: SelectionSetNode, type: GraphQLObjectType): number =>
    set.selections.reduce((count, selection) => {
      if (selection.kind === Kind.FIELD) {
        const field = type.getFields()[selection.name.value];
        if (!field) return count;
        const own = field.extensions["totalbaseCall"] === true ? 1 : 0;
        const inner = getNamedType(field.type);
        return count + own + (selection.selectionSet && isObjectType(inner) ? calls(selection.selectionSet, inner) : 0);
      }
      if (selection.kind === Kind.INLINE_FRAGMENT) return count + calls(selection.selectionSet, type);
      const fragment = fragments.get(selection.name.value);
      if (!fragment) return count;
      const key = `${fragment.name.value}@${type.name}`;
      let own = fragmentCalls.get(key);
      if (own === undefined) {
        fragmentCalls.set(key, 0); // a cycle (validation refuses one) counts nothing more
        own = calls(fragment.selectionSet, type);
        fragmentCalls.set(key, own);
      }
      return count + own;
    }, 0);
  const root = operation.operation === "mutation" ? schema.getMutationType() : operation.operation === "subscription" ? schema.getSubscriptionType() : schema.getQueryType();
  if (root && calls(operation.selectionSet, root) > limits.maxCalls) {
    throw new TotalBaseError("QUERY_COMPLEXITY_LIMIT_EXCEEDED", `More Data API calls than graphql.max_calls (${limits.maxCalls}): each root field and each one-to-many field is one.`);
  }

  const fragmentDepth = new Map<string, number>();
  const depth = (set: SelectionSetNode): number =>
    Math.max(0, ...set.selections.map((selection) => {
      if (selection.kind === Kind.FIELD) return selection.selectionSet ? 1 + depth(selection.selectionSet) : 1;
      if (selection.kind === Kind.INLINE_FRAGMENT) return depth(selection.selectionSet);
      const fragment = fragments.get(selection.name.value);
      if (!fragment) return 0;
      let own = fragmentDepth.get(fragment.name.value);
      if (own === undefined) {
        fragmentDepth.set(fragment.name.value, 0);
        own = depth(fragment.selectionSet);
        fragmentDepth.set(fragment.name.value, own);
      }
      return own;
    }));
  if (depth(operation.selectionSet) > limits.maxDepth) {
    throw new TotalBaseError("QUERY_DEPTH_LIMIT_EXCEEDED", `The selection nests deeper than graphql.max_depth (${limits.maxDepth}).`);
  }

  // Every field the response has per row, aliases apart: a fragment's count is reused, never re-walked, but multiplied
  // by every place it is spread - aliases of a relation each spreading a fragment of a thousand aliases is a million
  // values per row, which graphql-js would resolve one by one even though the SQL behind it is one small read.
  const fragmentFields = new Map<string, number>();
  const fieldCount = (set: SelectionSetNode): number =>
    set.selections.reduce((count, selection) => {
      if (selection.kind === Kind.FIELD) return count + 1 + (selection.selectionSet ? fieldCount(selection.selectionSet) : 0);
      if (selection.kind === Kind.INLINE_FRAGMENT) return count + fieldCount(selection.selectionSet);
      const fragment = fragments.get(selection.name.value);
      if (!fragment) return count;
      let own = fragmentFields.get(fragment.name.value);
      if (own === undefined) {
        fragmentFields.set(fragment.name.value, 0);
        own = fieldCount(fragment.selectionSet);
        fragmentFields.set(fragment.name.value, own);
      }
      return count + own;
    }, 0);
  if (fieldCount(operation.selectionSet) > limits.maxFields) {
    throw new TotalBaseError("QUERY_COMPLEXITY_LIMIT_EXCEEDED", `The operation selects more fields than graphql.max_fields (${limits.maxFields}), each fragment's counted wherever it is spread.`);
  }
  return operation;
}
