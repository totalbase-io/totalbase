/**
 * The Style tab's values as Tailwind classes on a placed widget's box
 * (@totalbase/tb-catalog COMMON_STYLE_PROPS). Every class is written out here, in
 * full, so Tailwind generates it - a class built from pieces never would.
 * Colors are the theme's tokens (Nuxt UI), so light and dark both work.
 */
const STYLE_CLASSES: Record<string, Record<string, string>> = {
  // All sides first: a side's class wins over it (Tailwind orders m- before mt-).
  margin: { xs: 'm-1', s: 'm-2', m: 'm-4', l: 'm-8', xl: 'm-12' },
  marginTop: { xs: 'mt-1', s: 'mt-2', m: 'mt-4', l: 'mt-8', xl: 'mt-12' },
  marginBottom: { xs: 'mb-1', s: 'mb-2', m: 'mb-4', l: 'mb-8', xl: 'mb-12' },
  marginLeft: { xs: 'ml-1', s: 'ml-2', m: 'ml-4', l: 'ml-8', xl: 'ml-12' },
  marginRight: { xs: 'mr-1', s: 'mr-2', m: 'mr-4', l: 'mr-8', xl: 'mr-12' },
  padding: { xs: 'p-1', s: 'p-2', m: 'p-4', l: 'p-6', xl: 'p-8' },
  paddingTop: { xs: 'pt-1', s: 'pt-2', m: 'pt-4', l: 'pt-6', xl: 'pt-8' },
  paddingBottom: { xs: 'pb-1', s: 'pb-2', m: 'pb-4', l: 'pb-6', xl: 'pb-8' },
  paddingLeft: { xs: 'pl-1', s: 'pl-2', m: 'pl-4', l: 'pl-6', xl: 'pl-8' },
  paddingRight: { xs: 'pr-1', s: 'pr-2', m: 'pr-4', l: 'pr-6', xl: 'pr-8' },
  border: { muted: 'border border-default', accented: 'border border-accented', primary: 'border border-primary' },
  radius: { s: 'rounded-sm', m: 'rounded-md', l: 'rounded-lg', full: 'rounded-full' },
  background: { muted: 'bg-muted', elevated: 'bg-elevated', accented: 'bg-accented', primary: 'bg-primary/10' },
  shadow: { s: 'shadow-sm', m: 'shadow-md', l: 'shadow-lg' },
  align: { start: 'text-left', center: 'text-center', end: 'text-right' },
  verticalAlign: { top: 'self-start', center: 'self-center', bottom: 'self-end', stretch: 'self-stretch' }
}

/** The classes a widget's Style values give its box - unset or unknown values give none. */
export function widgetStyleClasses(props: Record<string, unknown>): string[] {
  return Object.entries(STYLE_CLASSES).flatMap(([prop, classes]) => {
    const value = props[prop]
    return typeof value === 'string' && classes[value] ? [classes[value]] : []
  })
}

/** An option's icon color - a Radio group's Color field - as the theme's text color, written out for Tailwind. */
const OPTION_ICON_COLORS: Record<string, string> = {
  primary: 'text-primary',
  secondary: 'text-secondary',
  success: 'text-success',
  info: 'text-info',
  warning: 'text-warning',
  error: 'text-error',
  neutral: 'text-highlighted'
}

/** The class for one of the theme's colors (WIDGET_COLORS); undefined for anything else. */
export function optionIconColor(color: unknown): string | undefined {
  return typeof color === 'string' ? OPTION_ICON_COLORS[color] : undefined
}

/** A Radio group's Columns: its options as a grid that wraps - two per row on a phone. Written out for Tailwind. */
const OPTION_GRIDS: Record<string, string> = {
  1: 'grid gap-2 grid-cols-1',
  2: 'grid gap-2 grid-cols-2',
  3: 'grid gap-2 grid-cols-2 md:grid-cols-3',
  4: 'grid gap-2 grid-cols-2 md:grid-cols-4',
  5: 'grid gap-2 grid-cols-2 md:grid-cols-5',
  6: 'grid gap-2 grid-cols-2 md:grid-cols-6'
}

/** The grid classes for a Columns value (1-6); undefined for anything else. */
export function optionGridClass(columns: unknown): string | undefined {
  return typeof columns === 'string' || typeof columns === 'number' ? OPTION_GRIDS[String(columns)] : undefined
}

/** A Radio group's Icon size: its options' icons. Written out for Tailwind. */
const OPTION_ICON_SIZES: Record<string, string> = {
  'sm': 'size-4',
  'md': 'size-5',
  'lg': 'size-6',
  'xl': 'size-8',
  '2xl': 'size-10'
}

/** The size class for an Icon size value; undefined for anything else. */
export function optionIconSizeClass(size: unknown): string | undefined {
  return typeof size === 'string' ? OPTION_ICON_SIZES[size] : undefined
}
