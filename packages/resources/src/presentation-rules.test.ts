import type { RelationDetail } from "@totalbase/pg-catalog";
import { describe, expect, it } from "vitest";
import { mechanicalLabel, patternExample, suggestPresentation, type RulesInput } from "./presentation-rules.js";

const column = (name: string, dataType: string, nullable = true) =>
  ({ name, attnum: 0, dataType, nullable, isIdentity: false, isGenerated: false, defaultExpression: null }) as RelationDetail["columns"][number];

function detail(partial: Partial<RelationDetail>): RelationDetail {
  return { columns: [], primaryKey: [], relations: [], uniqueConstraints: [], uniqueConstraintNames: [], checkConstraints: [], ...partial } as RelationDetail;
}

const input = (d: RelationDetail, extra: Partial<RulesInput> = {}): RulesInput => ({ detail: d, comments: {}, current: {}, inherited: new Set(), row: null, isView: false, ...extra });

describe("suggest presentation by type and constraints (T69) - never by a column's name", () => {
  it("labels a value mechanically and writes an example a simple pattern accepts", () => {
    expect(mechanicalLabel("RESPONSABLE_INSCRIPTO")).toBe("Responsable Inscripto");
    expect(patternExample("^\\d{2}-\\d{8}-\\d$")).toBe("12-34567890-1");
    expect(patternExample("^[A-Z]{3}[0-9]+$")).toBeNull();
  });

  it("makes a unique whole number a code, a nullable column show —, a CHECK list's values labelled, a COMMENT the description", () => {
    const d = detail({
      columns: [column("id", "uuid", false), column("numero", "integer", false), column("estado", "text", false), column("nota", "text"), column("cuit", "text", false)],
      primaryKey: ["id"],
      uniqueConstraints: [["numero"]],
      checkConstraints: [
        { name: "e", expression: "CHECK ((estado = ANY (ARRAY['EMITIDA'::text, 'EN_CURSO'::text])))", message: null },
        { name: "c", expression: "CHECK ((cuit ~ '^\\d{2}-\\d{8}-\\d$'::text))", message: null },
      ] as RelationDetail["checkConstraints"],
    });
    const { columns } = suggestPresentation(input(d, { comments: { nota: "Lo que el operador anota." } }));
    const by = Object.fromEntries(columns.map((c) => [c.columnName, Object.fromEntries(c.suggestions.map((s) => [s.key, s.value]))]));
    expect(by.numero).toEqual({ mono: true });
    expect(by.estado).toEqual({ options: { EMITIDA: { label: "Emitida" }, EN_CURSO: { label: "En Curso" } } });
    expect(by.nota).toEqual({ description: "Lo que el operador anota.", emptyText: "—" });
    expect(by.cuit).toEqual({ placeholder: "12-34567890-1", mono: true });
    expect(by.id).toBeUndefined();
  });

  it("never offers what a column already has, marks a change of its own as one, skips a view's inherited columns", () => {
    const d = detail({ columns: [column("codigo", "integer", false), column("x", "text")], uniqueConstraints: [["codigo"]] });
    const same = suggestPresentation(input(d, { current: { codigo: { mono: true, input: "number-field" } }, inherited: new Set(["x"]) }));
    expect(same.columns).toEqual([]);
    const change = suggestPresentation(input(d, { current: { x: { emptyText: "n/a" } } }));
    expect(change.columns.find((c) => c.columnName === "x")!.suggestions).toEqual([{ key: "emptyText", value: "—", reason: "nullable", replaces: true }]);
  });

  it("never suggests a column's input - Automatic already gives the rule's (§15.2)", () => {
    const d = detail({
      columns: [column("monto", "numeric(12,2)"), column("mes", "integer", false), column("tope", "integer")],
      checkConstraints: [{ name: "m", expression: "CHECK (((mes >= 1) AND (mes <= 12)))", message: null }] as RelationDetail["checkConstraints"],
    });
    const { columns } = suggestPresentation(input(d, { current: { tope: { input: "number-stepper" } } }));
    expect(columns.flatMap((c) => c.suggestions).filter((s) => s.key === "input")).toEqual([]);
  });

  it("an email's pattern makes a link with its icon; a row shows by its first unique, required text", () => {
    const d = detail({
      columns: [column("id", "uuid", false), column("razon_social", "text", false), column("correo", "text", false)],
      primaryKey: ["id"],
      uniqueConstraints: [["razon_social"]],
      checkConstraints: [{ name: "m", expression: "CHECK ((correo ~* '^[^@]+@[^@]+$'::text))", message: null }] as RelationDetail["checkConstraints"],
    });
    const { columns, row } = suggestPresentation(input(d));
    expect(columns.find((c) => c.columnName === "correo")!.suggestions.map((s) => [s.key, s.value])).toEqual([["linkType", "email"], ["icon", "i-lucide-mail"]]);
    expect(row).toEqual({ displayField: "razon_social", reason: "unique-text" });
    expect(suggestPresentation(input(d, { row: { displayField: "id" } })).row).toBeNull();
  });
});
