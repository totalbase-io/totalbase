/**
 * A Modal's or a Slideover's width, one step per EditSize - neither Nuxt UI
 * component has a discrete size of its own (no `size` variant in their
 * theme), so it's a `:ui.content` max-width. The record form's container
 * (EditFormShell.vue) and a page's Modal and Slideover widgets share it:
 * one scale, learned once.
 */
import type { EditSize, FormSize } from '~/types/dataview'

export const OVERLAY_CONTENT_WIDTH: Record<EditSize, string> = {
  sm: 'max-w-md',
  md: 'max-w-2xl',
  lg: 'max-w-4xl',
  xl: 'max-w-6xl'
}

/**
 * A record form's Modal or Sidebar (EditFormShell.vue): `default` is the component's own Nuxt UI width (no
 * override - a Slideover's max-w-md, a Modal's max-w-lg), `sm` a step under it, `md`, `lg` and `xl` over it.
 * Apart from the widgets' scale above, whose `md` is already wider than either default.
 */
export const EDIT_FORM_WIDTH: Record<FormSize, string | undefined> = {
  default: undefined,
  sm: 'max-w-sm',
  md: 'max-w-xl',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl'
}

/** Sizes from max-w-2xl up are editors, not questions: fullscreen on a phone or a tablet (AGENTS.md section 25). */
export const FULLSCREEN_WHEN_COMPACT: readonly EditSize[] = ['md', 'lg', 'xl']
