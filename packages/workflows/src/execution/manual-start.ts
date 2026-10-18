import { TotalBaseError } from "@totalbase/errors";

/** One field of a MANUAL Start's input form (Specification_Workflows.md §6.2). */
export interface ManualInputField {
  name: string;
  label?: string;
  type: "text" | "number" | "boolean" | "date";
  required?: boolean;
}

const FIELD_TYPES = new Set(["text", "number", "boolean", "date"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A MANUAL Start's declared input form - empty when it declares none (any input is taken). */
export function manualInputFields(startConfiguration: Record<string, unknown>): ManualInputField[] {
  const raw = startConfiguration.input_fields;
  if (!Array.isArray(raw)) return [];
  return raw.filter((field): field is ManualInputField =>
    !!field && typeof field === "object" && typeof (field as ManualInputField).name === "string" && FIELD_TYPES.has((field as ManualInputField).type));
}

/**
 * Checks a run's input against the Start's input form: an object, each
 * required field present, each value of its type. A form that declares no
 * field takes any input. `WORKFLOW_VALIDATION_FAILED`, one line per field.
 */
export function validateManualInput(fields: ManualInputField[], input: unknown): void {
  if (fields.length === 0) return;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TotalBaseError("WORKFLOW_VALIDATION_FAILED", "This workflow's input is a form: send an object with its fields.");
  }
  const values = input as Record<string, unknown>;
  const problems: string[] = [];
  for (const field of fields) {
    const value = values[field.name];
    const label = field.label || field.name;
    if (value === undefined || value === null || value === "") {
      if (field.required) problems.push(`${label} is required.`);
      continue;
    }
    if (field.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) problems.push(`${label} must be a number.`);
    if (field.type === "boolean" && typeof value !== "boolean") problems.push(`${label} must be true or false.`);
    if (field.type === "date" && (typeof value !== "string" || !DATE.test(value))) problems.push(`${label} must be a date (YYYY-MM-DD).`);
    if (field.type === "text" && typeof value !== "string") problems.push(`${label} must be text.`);
  }
  if (problems.length > 0) throw new TotalBaseError("WORKFLOW_VALIDATION_FAILED", problems.join(" "));
}
