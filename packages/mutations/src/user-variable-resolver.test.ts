import { describe, expect, it } from "vitest";
import { userVariableResolver } from "./mutation-service.js";

describe("userVariableResolver()", () => {
  const resolve = userVariableResolver({
    principal: { type: "USER", id: "u1" },
    roleIds: [],
    userRow: { id: "u1", email: "a@b.test", password_hash: "$argon2id$secret" },
    actorUserId: "u1",
  });

  it("resolves a column of the caller's own users row", () => {
    expect(resolve("email")).toBe("a@b.test");
  });

  it("never resolves a protected column - a filter comparing against it would leak it", () => {
    // Regression: `where[name][_lt]=$USER.password_hash` compared a readable
    // column against the caller's password hash, one comparison at a time.
    expect(() => resolve("password_hash")).toThrow(expect.objectContaining({ code: "INVALID_QUERY", message: "Unknown $USER field: password_hash" }));
  });

  it("rejects an unknown column the same way", () => {
    expect(() => resolve("nope")).toThrow(expect.objectContaining({ code: "INVALID_QUERY", message: "Unknown $USER field: nope" }));
  });
});
