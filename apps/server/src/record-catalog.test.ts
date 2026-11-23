import { describe, expect, it } from "vitest";
import type { RelationDetail } from "@totalbase/pg-catalog";
import type { AppContext } from "./context.js";
import { readableCatalog } from "./record-catalog.js";

/**
 * Security regression: the catalog a viewer gets dropped the UNIQUE constraints on columns they can't read, and their
 * names - not their messages, which then sat at the wrong index and told what a hidden constraint guards.
 */
describe("readableCatalog", () => {
  it("drops a hidden constraint's message with it, keeping the rest aligned", async () => {
    const detail = {
      columns: [{ name: "id" }, { name: "email" }, { name: "salary_band" }],
      primaryKey: ["id"],
      relations: [],
      uniqueConstraints: [["salary_band"], ["email"]],
      uniqueConstraintNames: ["staff_salary_band_key", "staff_email_key"],
      uniqueConstraintMessages: ["Only one person per salary band", "That email is taken"],
      checkConstraints: [],
    } as unknown as RelationDetail;
    const read = { action: "ALLOW", fieldDecision: (field: string) => (field === "salary_band" ? "DENY" : "ALLOW") } as never;
    const catalog = await readableCatalog({} as AppContext, ["role"], "resource", { detail, passwords: new Set(), read });
    expect(catalog.uniqueConstraints).toEqual([["email"]]);
    expect(catalog.uniqueConstraintNames).toEqual(["staff_email_key"]);
    expect(catalog.uniqueConstraintMessages).toEqual(["That email is taken"]);
  });
});
