import type { Ref, WritableComputedRef } from 'vue'

/**
 * One key of an object `v-model` as its own writable ref - a write
 * replaces the object (`{ ...model, [key]: value }`), so the parent's
 * ref is reassigned rather than mutated through the prop.
 */
export function useModelField<T extends object>(model: Ref<T>) {
  return <K extends keyof T>(key: K): WritableComputedRef<T[K]> => computed({
    get: () => model.value[key],
    set: (value) => { model.value = { ...model.value, [key]: value } }
  })
}

/**
 * A formula slot of a layout config as a plain column pick - the
 * DataView wizard's pickers over a bare `{{column}}` formula
 * (utils/dataview-wizard-layouts.ts).
 */
export function useFormulaColumn(formula: WritableComputedRef<string | null>): WritableComputedRef<string | null> {
  return computed({
    get: () => formulaColumn(formula.value),
    set: (column) => { formula.value = columnFormula(column) }
  })
}
