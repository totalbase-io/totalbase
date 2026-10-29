import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLFloat,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLScalarType,
  GraphQLString,
  valueFromASTUntyped,
  type GraphQLInputFieldConfigMap,
  type GraphQLInputType,
  type GraphQLOutputType,
} from "graphql";

/** A GraphQL name (spec §2.1.9); a leading `__` is reserved for introspection. */
const NAME_PATTERN = /^[_A-Za-z][_0-9A-Za-z]*$/;

export function isGraphQLName(name: string): boolean {
  return NAME_PATTERN.test(name) && !name.startsWith("__");
}

/** json/jsonb, and the free-form `data` of an on_conflict UPDATE: any JSON value, passed through as is. */
export const GraphQLJSON = new GraphQLScalarType({
  name: "JSON",
  description: "Any JSON value.",
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral: (ast, variables) => valueFromASTUntyped(ast, variables),
});

/**
 * The scalar a column's values are (Data_API.md §17.2): Int only where 32 bits always hold it, Float for the
 * floating types; bigint and numeric are String - what the JSON carries, never rounded. Everything else is the
 * text PostgreSQL gives.
 */
type ScalarKind = "Int" | "Float" | "Boolean" | "JSON" | "String";

function scalarKind(dataType: string): ScalarKind {
  const base = dataType.replace(/\(.+\)$/, "").trim().toLowerCase();
  switch (base) {
    case "smallint":
    case "integer":
      return "Int";
    case "real":
    case "double precision":
      return "Float";
    case "boolean":
      return "Boolean";
    case "json":
    case "jsonb":
      return "JSON";
    default:
      return "String";
  }
}

const SCALARS: Record<ScalarKind, GraphQLScalarType> = {
  Int: GraphQLInt,
  Float: GraphQLFloat,
  Boolean: GraphQLBoolean,
  JSON: GraphQLJSON,
  String: GraphQLString,
};

function isArrayType(dataType: string): boolean {
  return dataType.endsWith("[]");
}

/** A column's type, as output and as a write's input; NOT NULL only where asked. */
export function columnType(dataType: string, nonNull: boolean): GraphQLOutputType & GraphQLInputType {
  const base = isArrayType(dataType) ? new GraphQLList(SCALARS[scalarKind(dataType.slice(0, -2))]) : SCALARS[scalarKind(dataType)];
  return nonNull ? new GraphQLNonNull(base) : base;
}

export const ORDER_DIRECTION = new GraphQLEnumType({
  name: "order_direction",
  values: { ASC: { value: "ASC" }, DESC: { value: "DESC" } },
});

export const ON_CONFLICT = new GraphQLInputObjectType({
  name: "on_conflict",
  description: "INSERT ... ON CONFLICT (Data_API.md §5.7): `target` names a PRIMARY KEY or UNIQUE column set.",
  fields: {
    target: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    action: {
      type: new GraphQLNonNull(new GraphQLEnumType({ name: "on_conflict_action", values: { NOTHING: { value: "NOTHING" }, UPDATE: { value: "UPDATE" } } })),
    },
    data: { type: GraphQLJSON, description: "UPDATE's values; they may reference `$INSERT.<field>`." },
  },
});

/**
 * The comparison inputs of the filter grammar (Data_API.md §3.3), one per scalar. Its operators are the
 * grammar's own; a value is passed on as the grammar takes it. `_null`/`_nnull` take no value in the grammar:
 * here they are `true`. An array or json column compares with PostgreSQL literals (`{a,b}`, `{"k": 1}`).
 */
function comparison(name: string, value: GraphQLScalarType, text: boolean, literal: boolean): GraphQLInputObjectType {
  const list = new GraphQLList(new GraphQLNonNull(value));
  const fields: GraphQLInputFieldConfigMap = {
    _eq: { type: value },
    _neq: { type: value },
    _gt: { type: value },
    _gte: { type: value },
    _lt: { type: value },
    _lte: { type: value },
    _in: { type: list },
    _nin: { type: list },
    _between: { type: list, description: "Exactly two values." },
    _null: { type: GraphQLBoolean, description: "IS NULL: only `true`." },
    _nnull: { type: GraphQLBoolean, description: "IS NOT NULL: only `true`." },
  };
  if (text) {
    fields["_like"] = { type: GraphQLString };
    fields["_ilike"] = { type: GraphQLString };
    fields["_regex"] = { type: GraphQLString };
  }
  if (literal) {
    fields["_contains"] = { type: GraphQLString };
    fields["_contained_by"] = { type: GraphQLString };
    fields["_overlap"] = { type: GraphQLString };
  }
  return new GraphQLInputObjectType({ name, fields });
}

const COMPARISONS = {
  Int: comparison("Int_comparison", GraphQLInt, false, false),
  Float: comparison("Float_comparison", GraphQLFloat, false, false),
  Boolean: comparison("Boolean_comparison", GraphQLBoolean, false, false),
  String: comparison("String_comparison", GraphQLString, true, false),
  literal: comparison("literal_comparison", GraphQLString, true, true),
};

export function comparisonType(dataType: string): GraphQLInputObjectType {
  if (isArrayType(dataType)) return COMPARISONS.literal;
  const kind = scalarKind(dataType);
  return kind === "JSON" ? COMPARISONS.literal : COMPARISONS[kind];
}

export function isOrderable(dataType: string): boolean {
  return !isArrayType(dataType) && scalarKind(dataType) !== "JSON";
}

/** Type names every schema holds - a resource whose own names would take one of them is left out. */
export const SHARED_TYPE_NAMES: readonly string[] = [
  // GraphQL's own: the root operation types and the built-in scalars, which a default-schema table could name.
  "Query",
  "Mutation",
  "Subscription",
  "Int",
  "Float",
  "String",
  "Boolean",
  "ID",
  "JSON",
  "order_direction",
  "on_conflict",
  "on_conflict_action",
  ...Object.values(COMPARISONS).map((type) => type.name),
];
