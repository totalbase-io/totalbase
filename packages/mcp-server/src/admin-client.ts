import { TotalBaseError } from "@totalbase/errors";
import { fixFor } from "./error-fixes.js";
/**
 * Thin HTTP client for TotalBase's Admin API (/admin/api/*) and Data API
 * (/api/*) - an administrator's plane="ADMIN" token reaches both
 * (Security.md §10), so an agent reads and writes
 * TotalBase's own records through the same engine as everything else.
 *
 * Authenticates with a personal access token (totalbase.tokens,
 * plane="ADMIN" - see Security.md §1). The token must
 * belong to a user holding the reserved Administrators role; the server
 * enforces that, not this client.
 */

export interface AdminApiErrorShape {
  source: "TOTALBASE" | "POSTGRESQL";
  code: string;
  message: string;
  /** Where in a document checked as a whole (a dashboard's spec): `widgets[3].config.roles.value`. */
  path?: string;
}

export class AdminApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly errors: AdminApiErrorShape[],
  ) {
    // Each with what fixes it (error-fixes.ts): the next tool to reach for, never a blind retry.
    super(errors.map((e) => `${e.path ? `${e.path}: ` : ""}${e.code}: ${e.message}${fixFor(e.code)}`).join("; ") || `Admin API request failed (${status})`);
    this.name = "AdminApiError";
  }
}

export interface AdminClientConfig {
  baseUrl: string;
  token: string;
  /** How long to wait before retrying a request refused for its rate (RATE_LIMIT_EXCEEDED) - tests shorten it. */
  rateLimitWaitsMs?: readonly number[];
  /** How requests travel - the global fetch by default; the server's /mcp passes one that injects them in-process. */
  fetch?: (url: URL, init: RequestInit) => Promise<Response>;
}

/**
 * The instance limits requests per client IP over a fixed one-minute window
 * (security.rate_limit_per_minute, 3000 by default, when rate limiting is on) - and every call of this
 * server comes from one IP. A refused request waits for the window to turn
 * and runs again, so a long build slows down instead of failing midway.
 */
const RATE_LIMIT_WAITS_MS = [15_000, 25_000, 25_000];

export class AdminClient {
  constructor(private readonly config: AdminClientConfig) {}

  /**
   * The URL for a path a tool built - often from an id a model passed (Administration.md §11.3). The path is only a
   * path - its query goes in `query` - and reaches exactly the route it names: a character a URL would rewrite or end
   * the path at (`\`, `?`, `#`, a space, a control character), an empty segment, or a segment that is - or decodes to -
   * `.`, `..`, or holds `/` `\` `?` `#`, is refused, and so is a URL whose path or origin came out other than written.
   * Otherwise `id: "..\\sql\\execute"` or `id: "x?"` would reach another route than the tool's, past the tool groups
   * and the mode the instance set.
   */
  private url(path: string): URL {
    const refuse = (): never => {
      throw new TotalBaseError("INVALID_QUERY", `Not a valid id in ${JSON.stringify(path)} - an id is one path segment: no ".", "..", "/", "\\", "?", "#", spaces or control characters.`);
    };
    if (!/^(\/[A-Za-z0-9\-._~%!$&'()*+,;=:@]+)+$/.test(path)) refuse();
    for (const segment of path.split("/").slice(1)) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return refuse();
      }
      if (decoded === "." || decoded === ".." || /[/\\?#\s\u0000-\u001f\u007f]/.test(decoded)) refuse();
    }
    const url = new URL(path, this.config.baseUrl);
    if (url.pathname !== path || url.origin !== new URL(this.config.baseUrl).origin) refuse();
    return url;
  }

  /** fetch, waiting out a rate limit (429) a few times before giving the refusal back. */
  private async fetch(url: URL, init: RequestInit): Promise<Response> {
    const waits = this.config.rateLimitWaitsMs ?? RATE_LIMIT_WAITS_MS;
    for (let attempt = 0; ; attempt += 1) {
      const response = await (this.config.fetch ?? fetch)(url, init);
      if (response.status !== 429 || attempt >= waits.length) return response;
      await response.body?.cancel();
      // The server says when its window resets (Retry-After, in seconds); tests set their own waits.
      const after = Number(response.headers.get("retry-after"));
      const wait = this.config.rateLimitWaitsMs === undefined && after > 0 ? after * 1000 : waits[attempt];
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  private async request<T>(method: string, path: string, body?: unknown, plane: "/admin/api" | "/api" = "/admin/api", query?: Record<string, string>): Promise<T> {
    return (await this.envelope<T>(method, path, body, plane, query)).data;
  }

  /** The whole response envelope - `data` and the `meta` beside it (a list's `count`) - and its status. */
  private async envelope<T>(method: string, path: string, body?: unknown, plane: "/admin/api" | "/api" = "/admin/api", query?: Record<string, string>): Promise<{ data: T; meta?: Record<string, unknown>; status: number }> {
    const url = this.url(`${plane}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await this.fetch(url, init);

    if (response.status === 204) return { data: undefined as T, status: 204 };

    const json = (await response.json().catch(() => null)) as
      | { data: T; meta?: Record<string, unknown> }
      | { errors: AdminApiErrorShape[] }
      | null;

    if (!response.ok || !json || "errors" in json) {
      const errors = json && "errors" in json ? json.errors : [{ source: "TOTALBASE" as const, code: "NETWORK_ERROR", message: response.statusText }];
      throw new AdminApiError(response.status, errors);
    }

    return { ...(json as { data: T; meta?: Record<string, unknown> }), status: response.status };
  }

  get<T>(path: string, query?: Record<string, string>): Promise<T> {
    return this.request<T>("GET", path, undefined, "/admin/api", query);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body ?? {});
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body ?? {});
  }

  /** A POST with its `meta` and status - a publish's warnings, and whether it created a version (201) or found the draft live (200). */
  postWithMeta<T>(path: string, body?: unknown): Promise<{ data: T; meta?: Record<string, unknown>; status: number }> {
    return this.envelope<T>("POST", path, body ?? {});
  }

  /** A PUT with its `meta` - a grant's advice (`meta.warnings`). */
  putWithMeta<T>(path: string, body?: unknown): Promise<{ data: T; meta?: Record<string, unknown>; status: number }> {
    return this.envelope<T>("PUT", path, body ?? {});
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, body ?? {});
  }

  delete<T>(path: string, query?: Record<string, string>): Promise<T> {
    return this.request<T>("DELETE", path, undefined, "/admin/api", query);
  }

  /**
   * A bare JSON document - not the `{ data }` envelope: the OpenAPI documents
   * (`/api/openapi.json`, `/admin/api/openapi`, `/admin/api/openapi/data`).
   */
  async document<T>(path: string, query?: Record<string, string>): Promise<T> {
    const url = this.url(path);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const response = await this.fetch(url, { headers: { Authorization: `Bearer ${this.config.token}` } });
    const json = (await response.json().catch(() => null)) as T | { errors: AdminApiErrorShape[] } | null;
    if (!response.ok || !json) {
      const errors = json && typeof json === "object" && "errors" in json ? json.errors : [{ source: "TOTALBASE" as const, code: "NETWORK_ERROR", message: response.statusText }];
      throw new AdminApiError(response.status, errors);
    }
    return json as T;
  }

  /** A POST answering a file (a rendered PDF): its type and size - the bytes themselves are no use to an agent. */
  async binary(path: string, body: unknown): Promise<{ contentType: string; bytes: number }> {
    const response = await this.fetch(this.url(path), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const json = (await response.json().catch(() => null)) as { errors?: AdminApiErrorShape[] } | null;
      throw new AdminApiError(response.status, json?.errors ?? [{ source: "TOTALBASE", code: "NETWORK_ERROR", message: response.statusText }]);
    }
    return { contentType: response.headers.get("content-type") ?? "", bytes: (await response.arrayBuffer()).byteLength };
  }

  /** A Data API read with its `meta` - `count=true` puts the total there. */
  dataWithMeta<T>(path: string, query: Record<string, string>): Promise<{ data: T; meta?: Record<string, unknown> }> {
    return this.envelope<T>("GET", path, undefined, "/api", query);
  }

  /** The Data API (/api/*): `path` like "/public/table/orders", `query` its query parameters (where[...], fields, order_by, ...). */
  data<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, options: { body?: unknown; query?: Record<string, string> } = {}): Promise<T> {
    return this.request<T>(method, path, options.body, "/api", options.query);
  }

  /** A multipart POST to the Data API - a file's content (`/totalbase/table/files`); answers its `data`. */
  async upload<T>(path: string, form: FormData): Promise<T> {
    const response = await this.fetch(this.url(`/api${path}`), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.token}` },
      body: form,
    });
    const json = (await response.json().catch(() => null)) as { data: T } | { errors: AdminApiErrorShape[] } | null;
    if (!response.ok || !json || "errors" in json) {
      const errors = json && "errors" in json ? json.errors : [{ source: "TOTALBASE" as const, code: "NETWORK_ERROR", message: response.statusText }];
      throw new AdminApiError(response.status, errors);
    }
    return json.data;
  }
}

/**
 * The filter grammar's object form ({ "status": { "_eq": "open" } }) as the
 * Data API's bracketed query parameters (where[status][_eq]=open); a list
 * of values (for _in / _nin / _between) is comma-joined, as the parser
 * expects; a list of filters (_and / _or) is indexed.
 */
export function whereParams(where: Record<string, unknown>, prefix = "where"): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(where)) {
    const name = `${prefix}[${key}]`;
    if (Array.isArray(value) && value.some((item) => item !== null && typeof item === "object")) {
      // _and / _or: a list of filters, indexed (qs parses where[_or][0][...] back into an array).
      value.forEach((item, index) => Object.assign(params, whereParams(item as Record<string, unknown>, `${name}[${index}]`)));
    } else if (Array.isArray(value)) params[name] = value.map(String).join(",");
    else if (value !== null && typeof value === "object") Object.assign(params, whereParams(value as Record<string, unknown>, name));
    else params[name] = String(value);
  }
  return params;
}

/** The stdio binary's configuration: TOTALBASE_URL and TOTALBASE_TOKEN (a plane="ADMIN" personal access token). */
export function loadConfigFromEnv(): AdminClientConfig {
  const baseUrl = process.env["TOTALBASE_URL"];
  if (!baseUrl) throw new Error("TOTALBASE_URL is required (e.g. http://localhost:3030).");
  const token = process.env["TOTALBASE_TOKEN"];
  if (!token) throw new Error("TOTALBASE_TOKEN is required (a plane=\"ADMIN\" personal access token).");
  return { baseUrl, token };
}
