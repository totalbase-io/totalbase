import { describe, expect, it } from "vitest";
import { buildColumnCreationBody, columnFormInput, columnInputsFor, COLUMN_INPUT_KEYS, COLUMN_INPUTS, creatableColumnInputs, integerRange } from "./column-inputs.js";
import { validateColumnPresentation } from "./column-presentation.js";
import { isWidgetName, widgetDefinition } from "../widgets/widget-catalog.js";

const facts = (dataType: string, checks: string[] = [], extra: Partial<Parameters<typeof columnFormInput>[0]> = {}) => ({
  name: "n",
  dataType,
  foreignKey: null,
  checks: checks.map((expression) => ({ expression, message: null })),
  ...extra,
});

describe("COLUMN_INPUTS (§16)", () => {
  it("has an entry for every key, each a form input of the widget catalog that edits its kinds", () => {
    for (const key of COLUMN_INPUT_KEYS) {
      const entry = COLUMN_INPUTS[key];
      expect(isWidgetName(entry.widget), key).toBe(true);
      expect(widgetDefinition(entry.widget).formField, key).toBe(true);
      // A choice edits a list's values whatever their type (a number's CHECK list - T61): its kinds aren't its widget's.
      if (entry.requires !== "check-list") for (const kind of entry.kinds) expect(widgetDefinition(entry.widget).accepts, `${key} ${kind}`).toContain(kind);
      // Its props are its widget's.
      for (const prop of Object.keys(entry.props ?? {})) expect(widgetDefinition(entry.widget).props, `${key}.${prop}`).toHaveProperty(prop);
      expect(entry.label && entry.description).toBeTruthy();
      expect(entry.icon).toMatch(/^i-lucide-/);
    }
  });

  it("creates with every entry but a range - which only reads one", () => {
    expect(COLUMN_INPUT_KEYS.filter((k) => !creatableColumnInputs().includes(k))).toEqual(["range"]);
  });
});

describe("columnFormInput() - the rule (§15.2)", () => {
  it("steps a smallint with − and +, whatever its range", () => {
    expect(columnFormInput(facts("smallint"))).toEqual({ input: "number-stepper", widget: "UInputNumber", props: {}, reason: "small-integer" });
    expect(columnFormInput(facts("bigint")).input).toBe("number-field");
  });

  it("writes a text on several lines and a varchar on one - by its type, never its name", () => {
    expect(columnFormInput(facts("text"))).toMatchObject({ input: "long-text", widget: "UTextarea", reason: "default" });
    expect(columnFormInput({ ...facts("text"), name: "nombre" }).input).toBe("long-text");
    expect(columnFormInput(facts("uuid"))).toMatchObject({ input: "uuid", widget: "TUuidInput", reason: "default" });
    // A ULID by its CHECK (PostgreSQL has no ulid type) - what Add Column writes.
    expect(columnFormInput(facts("character(26)", ["CHECK ((n ~ '^[0-9A-HJKMNP-TV-Z]{26}$'::text))"]))).toMatchObject({ input: "ulid", widget: "TUlidInput", reason: "pattern" });
    expect(buildColumnCreationBody("ulid", "code", {})).toEqual({ dataType: "char(26)", check: "code ~ '^[0-9A-HJKMNP-TV-Z]{26}$'" });
    for (const type of ["character varying", "character varying(80)", "character varying(2000)", "character(3)", "inet"]) {
      expect(columnFormInput(facts(type)), type).toMatchObject({ input: "text", widget: "UInput" });
    }
    // A chosen input still wins.
    expect(columnFormInput({ ...facts("text"), input: "text" }).input).toBe("text");
  });

  it("edits a number with a number field - but a whole number in a small CHECK range steps with − and +", () => {
    expect(columnFormInput(facts("numeric(12,2)"))).toEqual({ input: "number-field", widget: "UInput", props: { type: "text" }, reason: "number" });
    expect(columnFormInput(facts("double precision")).input).toBe("number-field");
    expect(columnFormInput(facts("integer")).input).toBe("number-field");
    expect(columnFormInput(facts("integer", ["CHECK (((n >= 1) AND (n <= 12)))"]))).toEqual({ input: "number-stepper", widget: "UInputNumber", props: {}, reason: "small-range" });
    expect(columnFormInput(facts("smallint", ["CHECK ((n > 0))", "CHECK ((n < 101))"])).input).toBe("number-stepper");
    expect(columnFormInput(facts("integer", ["CHECK (((n >= 0) AND (n <= 1000)))"])).input).toBe("number-field");
    expect(columnFormInput(facts("numeric", ["CHECK (((n >= (0)::numeric) AND (n <= (10)::numeric)))"])).input).toBe("number-field");
    expect(columnFormInput(facts("integer", ["CHECK ((n >= 0))"])).input).toBe("number-field");
  });

  it("a foreign key wins over the type: a file's an upload, any other a searchable relation", () => {
    expect(columnFormInput(facts("integer", [], { foreignKey: { targetSchema: "public", targetTable: "brands" } }))).toMatchObject({ input: "relation-search", widget: "USelectMenu", reason: "relation" });
    expect(columnFormInput(facts("uuid", [], { foreignKey: { targetSchema: "totalbase", targetTable: "files" } }))).toMatchObject({ input: "file", reason: "file" });
    // A number entry chosen before the foreign key came no longer edits it.
    expect(columnFormInput(facts("integer", [], { foreignKey: { targetSchema: "public", targetTable: "brands" }, input: "number-field" })).input).toBe("relation-search");
  });

  it("a CHECK list a select, a text[]'s checkboxes; a text by its link type or CHECK pattern", () => {
    expect(columnFormInput(facts("text", ["CHECK ((n = ANY (ARRAY['A'::text, 'B'::text])))"]))).toMatchObject({ input: "choice", reason: "check-list" });
    expect(columnFormInput(facts("integer", ["CHECK ((n = ANY (ARRAY[1, 2, 3])))"])).input).toBe("choice");
    expect(columnFormInput(facts("text[]", ["CHECK ((n <@ ARRAY['a'::text, 'b'::text]))"])).input).toBe("choice-multiple");
    expect(columnFormInput(facts("text"))).toEqual({ input: "long-text", widget: "UTextarea", props: {}, reason: "default" });
    expect(columnFormInput(facts("text", [], { linkType: "tel" }))).toMatchObject({ input: "phone", props: { type: "tel" }, reason: "link-type" });
    expect(columnFormInput(facts("text", ["CHECK ((n ~* '^[^@]+@[^@]+\\.[^@]+$'::text))"]))).toMatchObject({ input: "email", props: { type: "email" }, reason: "pattern" });
    expect(columnFormInput(facts("text", ["CHECK ((n ~* '^https?://'::text))"])).input).toBe("url");
    expect(columnFormInput(facts("boolean")).input).toBe("switch");
    expect(columnFormInput(facts("timestamp with time zone")).input).toBe("datetime");
    expect(columnFormInput(facts("tstzrange")).input).toBe("range");
  });

  it("keeps the chosen entry while it still edits the column", () => {
    expect(columnFormInput(facts("integer", [], { input: "slider" }))).toMatchObject({ input: "slider", widget: "USlider", reason: "chosen" });
    expect(columnFormInput(facts("text", [], { input: "markdown" }))).toMatchObject({ input: "markdown", props: { contentType: "markdown" } });
    // A choice entry without a CHECK list, an unknown key: the rule's.
    expect(columnFormInput(facts("text", [], { input: "choice" })).input).toBe("long-text");
    expect(columnFormInput(facts("text", [], { input: "nope" })).input).toBe("long-text");
  });

  it("offers every entry that edits the column", () => {
    expect(columnInputsFor(facts("numeric(5,2)"))).toEqual(["number-field", "number-stepper", "slider", "rating"]);
    expect(columnInputsFor(facts("text", ["CHECK ((n = ANY (ARRAY['A'::text])))"]))).toEqual(expect.arrayContaining(["text", "choice", "choice-radio", "choice-search"]));
    expect(columnInputsFor(facts("uuid", [], { foreignKey: { targetSchema: "public", targetTable: "brands" } }))).toEqual(["relation-search", "relation-select"]);
    expect(columnInputsFor(facts("uuid", [], { foreignKey: { targetSchema: "totalbase", targetTable: "files" } }))).toEqual(["file", "photo", "signature"]);
  });

  it("reads a whole number's inclusive range", () => {
    expect(integerRange("n", "integer", [{ expression: "CHECK ((n > 0) AND (n < 13))", message: null }])).toEqual({ min: 1, max: 12 });
    expect(integerRange("n", "numeric", [{ expression: "CHECK ((n >= 1) AND (n <= 12))", message: null }])).toBeNull();
  });
});

describe("a column presentation's input", () => {
  it("keeps an entry that edits its kind, and refuses another naming the valid ones", () => {
    expect(validateColumnPresentation({ input: "number-field" }, "number")).toEqual({ presentation: { input: "number-field" }, errors: [] });
    expect(validateColumnPresentation({ input: "switch" }, "number").errors[0]).toMatch(/^Input "switch" doesn't edit a number column - one of: number-field, number-stepper/);
    expect(validateColumnPresentation({ input: "nope" }, "text").errors).toHaveLength(1);
  });
});

describe("buildColumnCreationBody()", () => {
  it("UID: unique text plus the source it's generated from; no source is a bug", () => {
    expect(buildColumnCreationBody("uid", "slug", { uidSource: "title" })).toEqual({ dataType: "text", unique: true, uid: { source: "title" } });
    expect(() => buildColumnCreationBody("uid", "slug", {})).toThrow();
  });

  it("Text: plain text with no config", () => {
    expect(buildColumnCreationBody("text", "name", {})).toEqual({ dataType: "text", check: undefined });
  });

  it("Text: varchar(n) once maxLength is set, plus a minLength CHECK", () => {
    expect(buildColumnCreationBody("text", "name", { maxLength: 255, minLength: 2 })).toEqual({
      dataType: "varchar(255)",
      check: "length(name) >= 2",
    });
  });

  it("Email: fixed text + regex CHECK, independent of config", () => {
    expect(buildColumnCreationBody("email", "email", {})).toEqual({
      dataType: "text",
      check: "email ~* '^[^@]+@[^@]+\\.[^@]+$'",
    });
  });

  it("Decimal: numeric(12,scale) from config.decimals, default scale 2", () => {
    expect(buildColumnCreationBody("number-field", "price", {})).toEqual({ dataType: "numeric(12,2)", check: undefined });
    expect(buildColumnCreationBody("number-field", "price", { decimals: 4 })).toEqual({ dataType: "numeric(12,4)", check: undefined });
  });

  it("Integer: min/max become a combined CHECK", () => {
    expect(buildColumnCreationBody("number-stepper", "qty", { min: 0, max: 100 })).toEqual({
      dataType: "integer",
      check: "(qty >= 0) AND (qty <= 100)",
    });
  });

  it("Rating: BETWEEN 1 AND ratingLength, default 5", () => {
    expect(buildColumnCreationBody("rating", "stars", {})).toEqual({ dataType: "smallint", check: "stars BETWEEN 1 AND 5" });
    expect(buildColumnCreationBody("rating", "stars", { ratingLength: 10 })).toEqual({
      dataType: "smallint",
      check: "stars BETWEEN 1 AND 10",
    });
  });

  it("PIN: fixed-length CHECK only once pinLength is set", () => {
    expect(buildColumnCreationBody("pin", "code", {})).toEqual({ dataType: "text", check: undefined });
    expect(buildColumnCreationBody("pin", "code", { pinLength: 6 })).toEqual({ dataType: "text", check: "length(code) = 6" });
  });

  it("Choice: text + CHECK IN (...) from options", () => {
    expect(
      buildColumnCreationBody("choice", "status", {
        options: [
          { value: "open", label: "Open" },
          { value: "closed", label: "Closed" },
        ],
      }),
    ).toEqual({
      dataType: "text",
      check: "status IN ('open', 'closed')",
    });
  });

  it("Choice (multiple): text[] + CHECK <@ ARRAY[...]", () => {
    expect(buildColumnCreationBody("choice-multiple", "tags", { options: [{ value: "a", label: "A" }] })).toEqual({
      dataType: "text[]",
      check: "tags <@ ARRAY['a']",
    });
  });

  it("escapes a single quote in an option value", () => {
    expect(buildColumnCreationBody("choice", "kind", { options: [{ value: "o'brien", label: "O'Brien" }] })).toEqual({
      dataType: "text",
      check: "kind IN ('o''brien')",
    });
  });

  it("Relation (files): always FK to totalbase.files(id), uuid, no target picker needed", () => {
    expect(buildColumnCreationBody("file", "avatar", {})).toEqual({
      dataType: "uuid",
      foreignKey: { targetSchema: "totalbase", targetTable: "files", targetColumn: "id" },
    });
  });

  it("Relation (guided): uses the picked target's own data type, not a hardcoded uuid", () => {
    expect(
      buildColumnCreationBody("relation-select", "category_id", {
        relation: {
          targetSchema: "public",
          targetTable: "categories",
          targetColumn: "id",
          targetColumnDataType: "integer",
          onDelete: "CASCADE",
        },
      }),
    ).toEqual({
      dataType: "integer",
      foreignKey: { targetSchema: "public", targetTable: "categories", targetColumn: "id", onDelete: "CASCADE", onUpdate: undefined },
    });
  });

  it("throws for a relation column type with no target chosen yet", () => {
    expect(() => buildColumnCreationBody("relation-select", "category_id", {})).toThrow();
  });
});
