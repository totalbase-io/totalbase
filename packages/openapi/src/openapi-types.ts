/**
 * Minimal hand-rolled OpenAPI 3.1 document shape - only what
 * TotalBase actually emits, not a full spec typing (AGENTS.md
 * section 3: don't pre-build what a phase doesn't need).
 *
 * 3.1 schemas are plain JSON Schema: nullability is `type: [..., "null"]`,
 * never 3.0's `nullable: true` (which 3.1 tooling ignores).
 */
export interface JsonSchema {
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  description?: string;
  $ref?: string;
  [extension: string]: unknown;
}

export interface ParameterObject {
  name: string;
  in: "path" | "query" | "header";
  required?: boolean;
  schema: JsonSchema;
  description?: string;
}

export interface ResponseObject {
  description: string;
  content?: Record<string, { schema: JsonSchema }>;
}

export interface ReferenceObject {
  $ref: string;
}

/** OpenAPI's security requirement: scheme name -> required scopes (none for bearer). */
export type SecurityRequirement = Record<string, string[]>;

export interface OperationObject {
  operationId?: string;
  summary?: string;
  tags?: string[];
  parameters?: ParameterObject[];
  requestBody?: {
    required?: boolean;
    content: Record<string, { schema: JsonSchema }>;
  };
  responses: Record<string, ResponseObject | ReferenceObject>;
  /** Overrides the document-level `security`; `[]` marks an unauthenticated operation. */
  security?: SecurityRequirement[];
  [extension: string]: unknown;
}

export type PathItem = Partial<Record<"get" | "post" | "patch" | "delete" | "put", OperationObject>>;

export interface SecuritySchemeObject {
  type: "http";
  scheme: "bearer";
  description?: string;
}

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string; description?: string };
  servers?: { url: string; description?: string }[];
  security?: SecurityRequirement[];
  paths: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, JsonSchema>;
    responses?: Record<string, ResponseObject>;
    securitySchemes?: Record<string, SecuritySchemeObject>;
  };
}

/** Options shared by both generated documents. */
export interface OpenApiDocumentOptions {
  /** The instance's canonical external URL (`system.public_url`, AGENTS.md section 19A) - never the request's Host header. */
  publicUrl: string;
}
