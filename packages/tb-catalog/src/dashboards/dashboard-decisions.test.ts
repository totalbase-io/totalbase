import { describe, expect, it } from "vitest";
import { DASHBOARD_DECISION_CODES, dashboardDecision, decisionLanguage } from "./dashboard-decisions.js";

/** The one list of decision codes (Specification_Dashboards.md §5.19, DM3) - what the guide's "Reasons" lists. */
describe("dashboard decision codes", () => {
  const entries = Object.entries(DASHBOARD_DECISION_CODES) as [string, { description: string; message: Record<string, string> }][];
  const params = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it("each is kebab-case, described, and worded in every language with the same params", () => {
    for (const [code, entry] of entries) {
      expect(code, code).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(entry.description.length, code).toBeGreaterThan(10);
      expect(entry.message.en, code).toBeTruthy();
      expect(entry.message.es, code).toBeTruthy();
      expect(params(entry.message.es!), code).toEqual(params(entry.message.en!));
    }
  });

  it("the dashboard assistant's codes named in D27 are there", () => {
    for (const code of ["moment-several", "moment-not-null", "single-value", "uuid-without-fk", "no-stats"]) expect(Object.keys(DASHBOARD_DECISION_CODES)).toContain(code);
  });

  it("a decision's message is in the App's language, its code and detail never change", () => {
    const en = dashboardDecision("uuid-without-fk", decisionLanguage("en"), { column: "device" }, "uuid");
    const es = dashboardDecision("uuid-without-fk", decisionLanguage("es"), { column: "device" }, "uuid");
    expect([es.code, es.detail]).toEqual([en.code, en.detail]);
    expect(es.message).not.toBe(en.message);
    expect(es.message).toContain('"device"');
    expect(decisionLanguage("fr")).toBe("en");
  });
});
