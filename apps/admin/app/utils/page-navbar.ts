import type { InjectionKey, Ref } from 'vue'

/**
 * How many page navbars are on screen (PageShell's, each holding the phone's ☰) - provided by the layout, so it
 * shows its own minimal header, with the ☰, only on a page with none (an empty "Select a ..." placeholder).
 */
export const PAGE_NAVBARS_KEY: InjectionKey<Ref<number>> = Symbol('page-navbars')

/** The group panel is folded away (desktop): a page's header carries the button that opens it again. */
export const PANEL_FOLDED_KEY: InjectionKey<Ref<boolean>> = Symbol('panel-folded')

/** Where a PageHeader sits: a page's frame (its navbar, with the phone's ☰) or a PageShell embedded in another page. */
export const PAGE_FRAME_KEY: InjectionKey<'page' | 'embedded'> = Symbol('page-frame')
