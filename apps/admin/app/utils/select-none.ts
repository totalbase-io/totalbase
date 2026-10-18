import type { Ref } from 'vue'

/**
 * A select's "none" item - Default, Skip, "—" (Nuxt UI's Select/SelectMenu items can't have `''` as
 * their value). The model keeps `''`; only the items and the binding see this.
 */
export const SELECT_NONE = '__none__'

/** `model` bound through a select whose none item is SELECT_NONE - `''` in the model. */
export function selectNone(model: Ref<string>) {
  return computed<string>({
    get: () => model.value || SELECT_NONE,
    set: (value) => {
      model.value = value === SELECT_NONE ? '' : value
    }
  })
}
