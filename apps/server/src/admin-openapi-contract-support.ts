import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Database } from "@totalbase/database";
import { expect } from "vitest";
import type { AppContext } from "./context.js";
import { loadServerEnv } from "./env.js";
import { setupTestApp } from "./test-support.js";

export type Schema = { $ref?: string; type?: string | string[]; properties?: Record<string, Schema>; items?: Schema; allOf?: Schema[] };
type Operation = { responses: Record<string, { content?: Record<string, { schema: Schema }> }> };
export type Spec = { paths: Record<string, Record<string, Operation>>; components: { schemas: Record<string, Schema> } };

/**
 * Shared by the Admin API contract tests (admin-openapi-contract*.test.ts):
 * the real response's `data` must carry exactly the properties the
 * generated document declares - a renamed/added/removed field in a
 * service fails there instead of silently making the document lie (the
 * docs live next to each route as `config.openapi`, but nothing else ties
 * them to the code).
 */
export interface AdminContract {
  app: FastifyInstance;
  context: AppContext;
  database: Database;
  adminToken: string;
  spec: Spec;
  get(url: string): Promise<LightMyRequestResponse>;
  /** Resolves `$ref`/`allOf` down to the declared property names of an object schema. */
  declaredKeys(schema: Schema): string[];
  /** The documented schema of `data` in a route's success response. */
  dataSchema(path: string, method?: string, status?: string): Schema;
  /** GETs `url` and checks its `data` (an array's first row) against `path`'s documented 200 schema. */
  expectMatches(url: string, path: string): Promise<void>;
  /** Checks one object against a documented schema's keys. */
  expectKeys(sample: Record<string, unknown>, schema: Schema, label: string): void;
  close(): Promise<void>;
}

export async function setupAdminContract(): Promise<AdminContract> {
  const { app, context, database } = await setupTestApp();
  const env = loadServerEnv();
  const adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
  const get = (url: string) => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${adminToken}` } });
  const spec: Spec = (await get("/admin/api/openapi")).json();

  function declaredKeys(schema: Schema): string[] {
    if (schema.$ref) return declaredKeys(spec.components.schemas[schema.$ref.split("/").pop()!]!);
    if (schema.allOf) return schema.allOf.flatMap(declaredKeys);
    return Object.keys(schema.properties ?? {});
  }

  function dataSchema(path: string, method = "get", status = "200"): Schema {
    const operation = spec.paths[path]?.[method];
    expect(operation, `${method.toUpperCase()} ${path} is not in the document`).toBeDefined();
    const schema = operation!.responses[status]?.content?.["application/json"]?.schema;
    expect(schema, `${method.toUpperCase()} ${path} documents no ${status} body`).toBeDefined();
    return schema!.properties!["data"]!;
  }

  function expectKeys(sample: Record<string, unknown>, schema: Schema, label: string) {
    expect(Object.keys(sample).sort(), label).toEqual([...new Set(declaredKeys(schema))].sort());
  }

  async function expectMatches(url: string, path: string) {
    const res = await get(url);
    expect(res.statusCode, url).toBe(200);
    const data = res.json().data;
    const documented = dataSchema(path);
    const sample = documented.type === "array" ? data[0] : data;
    expect(sample, `${url} returned no rows to compare`).toBeDefined();
    expectKeys(sample, documented.type === "array" ? documented.items! : documented, url);
  }

  return {
    app,
    context,
    database,
    adminToken,
    spec,
    get,
    declaredKeys,
    dataSchema,
    expectMatches,
    expectKeys,
    close: async () => {
      await app.close();
      await database.close();
    },
  };
}
