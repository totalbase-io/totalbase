import { describe, expect, it } from "vitest";
import { buildAddCheckConstraintSql } from "./table-schema-service.js";

describe("a CHECK's SQL", () => {
  it("keeps a question mark - a regex quantifier, never a Knex binding", () => {
    expect(buildAddCheckConstraintSql("public", "t", "t_site_check", "site ~* '^https?://'")).toBe(
      `alter table "public"."t" add constraint t_site_check check(site ~* '^https?://')`,
    );
  });
});
