import type { InjectionKey, Ref } from 'vue'

export type SurfaceTone = 'light' | 'dark'

/** Provided by ShellSurface.vue: the tone of the shell part a component sits in. */
export const SURFACE_TONE: InjectionKey<Readonly<Ref<SurfaceTone>>> = Symbol('surface-tone')

/**
 * Whether what a component draws sits on light or dark - for the colors picked in script (an object's or a role's
 * shade), which CSS's `dark:` can't reach. The page's color mode, except inside a dark rail or panel in midnight
 * (ShellSurface.vue).
 */
export function useSurfaceTone(): Readonly<Ref<SurfaceTone>> {
  const colorMode = useColorMode()
  return inject(SURFACE_TONE, null) ?? computed(() => (colorMode.value === 'dark' ? 'dark' : 'light'))
}
