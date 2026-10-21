import type { FastifyInstance, FastifyRequest } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import { AdminClient, policyFromSettings, serveMcpRequest } from "@totalbase/mcp-server";
import type { AppContext } from "./context.js";
import { requireAdmin } from "./auth-guards.js";
import { INTERNAL_REQUEST_HEADER, RateLimiter } from "./hardening.js";

/**
 * The MCP server, served by the TotalBase server itself at POST /mcp
 * (Administration.md §11.5, §11.7) - one service, one port.
 * HTTP only here: authentication (an administrator's bearer token, as the
 * Admin API takes it), Settings > MCP read per request (on/off, the policy,
 * the per-token limit, the allowed hosts). The tools are @totalbase/mcp-server's;
 * their calls to the Admin and Data APIs are injected in-process
 * (app.inject) with the caller's own token, IP and a "TotalBase MCP" user
 * agent - every decision, permission and audit entry is the same as over
 * the network, and the per-IP limit isn't spent twice on one tool call.
 */
export function registerMcpEndpoint(app: FastifyInstance, context: AppContext, internalKey: string): void {
  const limiter = new RateLimiter();
  const sweep = setInterval(() => limiter.sweep(), 60_000);
  sweep.unref();
  app.addHook("onClose", (_instance, done) => {
    clearInterval(sweep);
    done();
  });

  const settingsOf = async () => context.settings.getGroup("mcp");

  /** Off: /mcp answers as if it didn't exist. */
  async function assertEnabled() {
    if ((await context.settings.get("mcp.enabled")) !== true) throw new TotalBaseError("RESOURCE_NOT_FOUND", "MCP is off on this instance - an administrator turns it on in Settings > MCP.");
  }

  /**
   * The Host a request names: one of mcp.allowed_hosts, or - with none
   * listed - the public URL's host (system.public_url, else TOTALBASE_PUBLIC_URL) or localhost. Refuses a page that makes a
   * browser call /mcp through a name it controls (DNS rebinding).
   */
  async function assertHost(request: FastifyRequest) {
    const host = (request.headers.host ?? "").toLowerCase();
    const allowed = (await context.settings.get("mcp.allowed_hosts")).map((h) => h.toLowerCase());
    if (allowed.length > 0 ? allowed.includes(host) : isDefaultHost(host, await context.auth.mailer.publicUrl())) return;
    throw new TotalBaseError("PERMISSION_DENIED", `Host ${host || "(none)"} may not reach /mcp - add it to Settings > MCP > Allowed hosts.`);
  }

  const notStateless = async () => {
    await assertEnabled();
    throw new TotalBaseError("INVALID_QUERY", "This MCP server runs stateless: only POST /mcp.");
  };
  app.get("/mcp", notStateless);
  app.delete("/mcp", notStateless);

  app.post(
    "/mcp",
    {
      preHandler: [
        async (request) => {
          await assertEnabled();
          await assertHost(request);
        },
        requireAdmin(context),
      ],
    },
    async (request, reply) => {
      const limit = await context.settings.get("mcp.rate_limit_per_minute");
      const caller = request.adminToken ?? request.adminSession ?? request.admin?.id ?? request.ip;
      if (!limiter.consume(`mcp:${caller}`, limit)) {
        reply.header("retry-after", String(limiter.retryAfterSeconds(`mcp:${caller}`)));
        throw new TotalBaseError("RATE_LIMIT_EXCEEDED", "Too many MCP requests for this token - Settings > MCP > Requests per minute.");
      }

      const authorization = request.headers.authorization ?? "";
      const userAgent = `TotalBase MCP (${request.headers["user-agent"] ?? "client"})`;
      const remoteAddress = request.ip;
      const client = new AdminClient({
        baseUrl: "http://totalbase.internal",
        token: authorization.replace(/^Bearer\s+/i, ""),
        fetch: async (url, init) => {
          // A JSON body as it is; any other (upload_file's FormData) as its bytes, with the content type - a
          // multipart boundary - the platform's Request gives it.
          let payload: string | Buffer | undefined = typeof init.body === "string" ? init.body : undefined;
          const requestHeaders: Record<string, string> = { ...(init.headers as Record<string, string>) };
          if (init.body && typeof init.body !== "string") {
            const encoded = new Request(url, { method: init.method ?? "POST", body: init.body });
            payload = Buffer.from(await encoded.arrayBuffer());
            const contentType = encoded.headers.get("content-type");
            if (contentType) requestHeaders["content-type"] = contentType;
          }
          const response = await app.inject({
            method: (init.method ?? "GET") as "GET",
            url: `${url.pathname}${url.search}`,
            headers: { ...requestHeaders, "user-agent": userAgent, [INTERNAL_REQUEST_HEADER]: internalKey },
            ...(payload !== undefined && { payload }),
            remoteAddress,
          });
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
          }
          return new Response(response.statusCode === 204 || response.statusCode === 304 ? null : response.rawPayload, { status: response.statusCode, headers });
        },
      });

      const policy = policyFromSettings(await settingsOf());
      reply.hijack();
      await serveMcpRequest(request.raw, reply.raw, request.body, client, policy);
    },
  );
}

/** With no hosts listed: the public URL's host, or localhost / 127.0.0.1 on any port. */
function isDefaultHost(host: string, publicUrl: string): boolean {
  const name = host.replace(/:\d+$/, "");
  if (name === "localhost" || name === "127.0.0.1" || name === "[::1]") return true;
  try {
    return publicUrl !== "" && new URL(publicUrl).host.toLowerCase() === host;
  } catch {
    return false;
  }
}
