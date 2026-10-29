import { getDirectiveValues, GraphQLIncludeDirective, GraphQLSkipDirective, Kind, type FieldNode, type GraphQLResolveInfo, type ResponsePath, type SelectionSetNode } from "graphql";
import { TotalBaseError } from "@totalbase/errors";
import { ROW_VERSION_COLUMN } from "@totalbase/query-engine";

/**
 * A row type's relation fields, by name: `brand_row` reaches the row `brand` points at (Data_API.md §17.4).
 * Everything in a selection, a `where` or an `order_by` that is not one is a column.
 */
export interface Shape {
  relations: Map<string, { fk: string; typeName: string }>;
  /** One-to-many fields: a read of their own, which needs this row's `parentKey` to find its rows. */
  toMany?: Map<string, { parentKey: string }>;
  /** `_version` is the row's version, read with it - not a column (Data_API.md §5.3). */
  version?: boolean;
}

export type Shapes = Map<string, Shape>;

function shapeOf(shapes: Shapes, typeName: string): Shape {
  const shape = shapes.get(typeName);
  if (!shape) throw new Error(`No shape for GraphQL type ${typeName}`);
  return shape;
}

/**
 * The selection of a root field as the `fields` paths REST takes (Data_API.md §3.2): a column is its name, a
 * relation field's columns are dotted under its foreign key - `brand_row { name }` is `brand.name`. Fragments
 * and @skip/@include are followed; `__typename` is GraphQL's, not a field.
 */
export function selectedPaths(
  info: Pick<GraphQLResolveInfo, "fieldNodes" | "fragments" | "variableValues">,
  shapes: Shapes,
  typeName: string,
  options: { toMany?: "read" | "refuse" } = {},
): string[] {
  const paths = new Set<string>();
  const included = includedIn(info);

  const walk = (selectionSet: SelectionSetNode, type: string, prefix: string[]) => {
    const shape = shapeOf(shapes, type);
    for (const selection of selectionSet.selections) {
      if (!included(selection)) continue;
      if (selection.kind === Kind.FIELD) {
        const name = selection.name.value;
        if (name.startsWith("__") || (name === "_version" && shape.version)) continue;
        const toMany = shape.toMany?.get(name);
        const relation = shape.relations.get(name);
        if (toMany && options.toMany === "refuse") {
          throw new TotalBaseError("INVALID_QUERY", `${name} is a read of its own: a subscription doesn't deliver it - read it when the event comes.`);
        } else if (toMany) {
          // Read by its own resolver; this read only needs the key its rows point at.
          paths.add([...prefix, toMany.parentKey].join("."));
        } else if (relation) {
          if (selection.selectionSet) walk(selection.selectionSet, relation.typeName, [...prefix, relation.fk]);
        } else {
          paths.add([...prefix, name].join("."));
        }
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        walk(selection.selectionSet, type, prefix);
      } else {
        const fragment = info.fragments[selection.name.value];
        if (fragment) walk(fragment.selectionSet, type, prefix);
      }
    }
  };
  for (const node of info.fieldNodes) if (node.selectionSet) walk(node.selectionSet, typeName, []);
  return [...paths];
}

function includedIn(info: Pick<GraphQLResolveInfo, "variableValues">) {
  return (node: Parameters<typeof getDirectiveValues>[1]) =>
    getDirectiveValues(GraphQLSkipDirective, node, info.variableValues)?.["if"] !== true &&
    getDirectiveValues(GraphQLIncludeDirective, node, info.variableValues)?.["if"] !== false;
}

/** The nodes of the field `name` selected directly under the root field - through fragments, after @skip/@include. */
export function subFieldNodes(info: Pick<GraphQLResolveInfo, "fieldNodes" | "fragments" | "variableValues">, name: string): FieldNode[] {
  const included = includedIn(info);
  const found: FieldNode[] = [];
  const walk = (selectionSet: SelectionSetNode) => {
    for (const selection of selectionSet.selections) {
      if (!included(selection)) continue;
      if (selection.kind === Kind.FIELD) {
        if (selection.name.value === name) found.push(selection);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        walk(selection.selectionSet);
      } else {
        const fragment = info.fragments[selection.name.value];
        if (fragment) walk(fragment.selectionSet);
      }
    }
  };
  for (const node of info.fieldNodes) if (node.selectionSet) walk(node.selectionSet);
  return found;
}

/**
 * Rows as REST answers them - a relation path's value under its dotted key - as GraphQL's nested objects. A
 * related row whose every selected value is null is null: the LEFT JOIN found none, or nothing in it is set.
 * Values go through JSON first, as the REST response does (a timestamp is its ISO text).
 */
export function nestRows(rows: unknown[], shapes: Shapes, typeName: string): Record<string, unknown>[] {
  const plain = JSON.parse(JSON.stringify(rows)) as (Record<string, unknown> | null)[];
  return plain.map((row) => (row === null ? row : nestRow(row, shapes, typeName))) as Record<string, unknown>[];
}

function nestRow(row: Record<string, unknown>, shapes: Shapes, typeName: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    // The row's version comes back under the read's own column name (ROW_VERSION_COLUMN).
    const segments = key === ROW_VERSION_COLUMN ? ["_version"] : key.split(".");
    let target = out;
    let type = typeName;
    for (const fk of segments.slice(0, -1)) {
      const [field, relation] = [...shapeOf(shapes, type).relations].find(([, r]) => r.fk === fk) ?? [];
      if (!field || !relation) break;
      target = (target[field] ??= {}) as Record<string, unknown>;
      type = relation.typeName;
    }
    target[segments[segments.length - 1]!] = value;
  }
  collapseEmpty(out, shapes, typeName);
  return out;
}

/** Whether every value under `object` is null - its empty relation objects become null on the way. */
function collapseEmpty(object: Record<string, unknown>, shapes: Shapes, typeName: string): boolean {
  let empty = true;
  for (const [key, value] of Object.entries(object)) {
    const relation = shapeOf(shapes, typeName).relations.get(key);
    if (relation && value !== null && typeof value === "object") {
      if (collapseEmpty(value as Record<string, unknown>, shapes, relation.typeName)) object[key] = null;
      else empty = false;
    } else if (value !== null) {
      empty = false;
    }
  }
  return empty;
}

/**
 * A `where` input as the one filter grammar (Data_API.md §3.3), for parseFilter() to take unchanged: the same
 * keys and operators, a relation field's conditions under their dotted paths. Two conditions on one key (a
 * relation's `_or` beside the row's own) are AND-ed, as siblings are.
 */
export function filterFromInput(input: unknown, shapes: Shapes, typeName: string, prefix: string[] = []): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input; // parseFilter's to refuse
  const shape = shapeOf(shapes, typeName);
  const out: Record<string, unknown> = {};
  const more: Record<string, unknown>[] = [];
  const put = (key: string, value: unknown) => {
    if (key in out) more.push({ [key]: value });
    else out[key] = value;
  };

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (key === "_and" || key === "_or") {
      put(key, Array.isArray(value) ? value.map((item) => filterFromInput(item, shapes, typeName, prefix)) : value);
    } else if (key === "_not") {
      put(key, filterFromInput(value, shapes, typeName, prefix));
    } else if (shape.relations.has(key)) {
      const relation = shape.relations.get(key)!;
      if (value === null) throw new TotalBaseError("INVALID_QUERY", `Invalid filter for field: ${key}`);
      const inner = filterFromInput(value, shapes, relation.typeName, [...prefix, relation.fk]) as Record<string, unknown>;
      for (const [innerKey, innerValue] of Object.entries(inner)) put(innerKey, innerValue);
    } else {
      put([...prefix, key].join("."), comparisonFromInput([...prefix, key].join("."), value));
    }
  }
  return more.length > 0 ? { _and: [out, ...more] } : out;
}

function comparisonFromInput(path: string, value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  for (const operator of ["_null", "_nnull"]) {
    const flag = (value as Record<string, unknown>)[operator];
    if (flag !== undefined && flag !== true) {
      throw new TotalBaseError("INVALID_QUERY", `${operator} takes only true (${path}).`);
    }
  }
  return value;
}

/** An `order_by` list as REST's `order_by` (`-price,brand.name`); one field per item, so the order is the list's. */
export function orderByFromInput(input: unknown, shapes: Shapes, typeName: string): string | undefined {
  if (input === undefined || input === null) return undefined;
  const items = Array.isArray(input) ? input : [input];
  return items.map((item) => orderEntry(item, shapes, typeName, [])).join(",");
}

function orderEntry(item: unknown, shapes: Shapes, typeName: string, prefix: string[]): string {
  const entries = Object.entries((item ?? {}) as Record<string, unknown>).filter(([, value]) => value !== undefined && value !== null);
  if (entries.length !== 1) {
    throw new TotalBaseError("INVALID_QUERY", "Each order_by item names exactly one field; list several items to order by several.");
  }
  const [key, value] = entries[0]!;
  const relation = shapeOf(shapes, typeName).relations.get(key);
  if (relation) return orderEntry(value, shapes, relation.typeName, [...prefix, relation.fk]);
  return `${value === "DESC" ? "-" : ""}${[...prefix, key].join(".")}`;
}

/** A response path without its list indices: every row of one field, with one alias, is one key. */
export function pathKey(path: ResponsePath | undefined): string {
  const keys: string[] = [];
  for (let node = path; node; node = node.prev) if (typeof node.key === "string") keys.unshift(node.key);
  return keys.join(".");
}

/**
 * Batches the loads of one request: the keys asked for under one batch key in the same turn of the event
 * loop go to one `run` - every parent row of a one-to-many field, resolved one by one by graphql-js, becomes
 * one read. setImmediate, not a microtask: the parents of a nested level resolve over several microtasks.
 */
export class Batcher {
  private readonly pending = new Map<string, { keys: Set<string>; result: Promise<Map<string, unknown[]>> }>();

  load(batch: string, key: string, run: (keys: string[]) => Promise<Map<string, unknown[]>>): Promise<unknown[]> {
    let entry = this.pending.get(batch);
    if (!entry) {
      const keys = new Set<string>();
      const result = new Promise<Map<string, unknown[]>>((resolve, reject) => {
        setImmediate(() => {
          this.pending.delete(batch);
          run([...keys]).then(resolve, reject);
        });
      });
      entry = { keys, result };
      this.pending.set(batch, entry);
    }
    entry.keys.add(key);
    return entry.result.then((rows) => rows.get(key) ?? []);
  }
}
