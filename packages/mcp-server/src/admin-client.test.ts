import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminApiError, AdminClient, whereParams } from "./admin-client.js";

describe("AdminClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("unwraps the {data} envelope and attaches the bearer token", async () => {
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      expect(url.toString()).toBe("http://localhost:3000/admin/api/roles");
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tb_test");
      return new Response(JSON.stringify({ data: [{ id: "r1", name: "Administrators" }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AdminClient({ baseUrl: "http://localhost:3000", token: "tb_test" });
    const roles = await client.get("/roles");
    expect(roles).toEqual([{ id: "r1", name: "Administrators" }]);
  });

  it("throws AdminApiError with the server's error list on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ errors: [{ source: "TOTALBASE", code: "PERMISSION_DENIED", message: "nope" }] }), { status: 403 })),
    );

    const client = new AdminClient({ baseUrl: "http://localhost:3000", token: "tb_test" });
    await expect(client.post("/tokens", { data: { name: "x" } })).rejects.toBeInstanceOf(AdminApiError);
  });

  it("treats a 204 response as no content", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const client = new AdminClient({ baseUrl: "http://localhost:3000", token: "tb_test" });
    await expect(client.post("/tokens/x/revoke")).resolves.toBeUndefined();
  });

  it("delete() sends no body and no content-type header", async () => {
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      expect(url.toString()).toBe("http://localhost:3000/admin/api/schema/public/tables/x");
      expect(init.method).toBe("DELETE");
      expect(init.body).toBeUndefined();
      expect((init.headers as Record<string, string>)["content-type"]).toBeUndefined();
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AdminClient({ baseUrl: "http://localhost:3000", token: "tb_test" });
    await client.delete("/schema/public/tables/x");
  });

  it("data() reaches the Data API with query parameters", async () => {
    const fetchMock = vi.fn(async (url: URL) => {
      expect(url.pathname).toBe("/api/totalbase/table/roles");
      expect(url.searchParams.get("where[name][_eq]")).toBe("Sales");
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new AdminClient({ baseUrl: "http://localhost:3000", token: "tb_test" });
    await expect(client.data("GET", "/totalbase/table/roles", { query: whereParams({ name: { _eq: "Sales" } }) })).resolves.toEqual([]);
  });
});

describe("AdminClient rate limit", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("waits out RATE_LIMIT_EXCEEDED and runs the request again", async () => {
    const limited = () => new Response(JSON.stringify({ errors: [{ source: "TOTALBASE", code: "RATE_LIMIT_EXCEEDED", message: "Too many requests." }] }), { status: 429 });
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => limited())
      .mockImplementationOnce(async () => new Response(JSON.stringify({ data: { ok: 1 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new AdminClient({ baseUrl: "http://localhost:3000", token: "tb_test", rateLimitWaitsMs: [1] });
    await expect(client.put("/roles/r/resources/x/permissions/READ", { data: { effect: "ALLOW" } })).resolves.toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives the refusal back once its waits are spent", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ errors: [{ source: "TOTALBASE", code: "RATE_LIMIT_EXCEEDED", message: "Too many requests." }] }), { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new AdminClient({ baseUrl: "http://localhost:3000", token: "tb_test", rateLimitWaitsMs: [1, 1] });
    await expect(client.get("/auth/me")).rejects.toThrow(/RATE_LIMIT_EXCEEDED/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("whereParams", () => {
  it("turns the filter object into the Data API's bracketed parameters", () => {
    expect(whereParams({
      status: { _in: ["open", "late"] },
      total: { _gte: 100 },
      _or: [{ owner: { _eq: "a" } }, { owner: { _null: true } }],
    })).toEqual({
      "where[status][_in]": "open,late",
      "where[total][_gte]": "100",
      "where[_or][0][owner][_eq]": "a",
      "where[_or][1][owner][_null]": "true",
    });
  });
});
