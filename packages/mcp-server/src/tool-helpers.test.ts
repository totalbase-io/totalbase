import { describe, expect, it } from "vitest";
import { filterForStorage, publishOutcome } from "./tool-helpers.js";

describe("filterForStorage", () => {
  it("spells every value as the grammar stores it - text", () => {
    expect(filterForStorage({ activo: { _eq: true }, total: { _gte: 100 }, estado: { _in: ["A", "B"] }, _or: [{ vip: { _eq: false } }, { owner: { _eq: "$USER.id" } }], deleted_at: { _null: true } })).toEqual({
      activo: { _eq: "true" },
      total: { _gte: "100" },
      estado: { _in: "A,B" },
      _or: [{ vip: { _eq: "false" } }, { owner: { _eq: "$USER.id" } }],
      deleted_at: { _null: "true" },
    });
  });

  it("leaves templates and text alone", () => {
    expect(filterForStorage({ municipio: { _eq: "{{vars.record.data.municipio}}" } })).toEqual({ municipio: { _eq: "{{vars.record.data.municipio}}" } });
  });
});

describe("publishOutcome", () => {
  it("says whether a publish created the version (201) or found the draft already live (200), with a note to look again", () => {
    expect(publishOutcome(3, 201)).toEqual({ version: 3, published: true });
    expect(publishOutcome(2, 200)).toEqual({ version: 2, published: false, note: expect.stringContaining("nothing was published") });
  });
});
