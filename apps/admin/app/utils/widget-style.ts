/**
 * The Style tab's values as Tailwind classes on a placed widget's box
 * (@totalbase/tb-catalog COMMON_STYLE_PROPS). Every class is written out here, in
 * full, so Tailwind generates it - a class built from pieces never would.
 * Colors are the theme's tokens (Nuxt UI), so light and dark both work.
 */
import { SPACING_SIZES, SPACING_STEPS } from '@totalbase/tb-catalog'

/**
 * A spacing prop's classes: the named sizes through their step (SPACING_SIZES - one scale for margin and
 * padding) and every step of the scale (SPACING_STEPS, Custom in the Style tab), as `<prefix>-<step>` -
 * main.css generates those with `@source inline`, the same ones the CSS classes field may use, so a composed
 * class exists here and nowhere else.
 */
function spacing(prefix: string): Record<string, string> {
  return Object.fromEntries([...Object.entries(SPACING_SIZES), ...SPACING_STEPS.map(step => [step, step])].map(([name, step]) => [name, `${prefix}-${step}`]))
}

const STYLE_CLASSES: Record<string, Record<string, string>> = {
  // All sides first: a side's class wins over it (Tailwind orders m- before mt-).
  margin: spacing('m'),
  marginTop: spacing('mt'),
  marginBottom: spacing('mb'),
  marginLeft: spacing('ml'),
  marginRight: spacing('mr'),
  padding: spacing('p'),
  paddingTop: spacing('pt'),
  paddingBottom: spacing('pb'),
  paddingLeft: spacing('pl'),
  paddingRight: spacing('pr'),
  border: { muted: 'border border-default', accented: 'border border-accented', primary: 'border border-primary' },
  radius: { s: 'rounded-sm', m: 'rounded-md', l: 'rounded-lg', full: 'rounded-full' },
  background: { muted: 'bg-muted', elevated: 'bg-elevated', accented: 'bg-accented', primary: 'bg-primary/10' },
  shadow: { s: 'shadow-sm', m: 'shadow-md', l: 'shadow-lg' },
  // Its text: the theme's type scale and text colors, cascading to what the box holds.
  fontSize: { 'xs': 'text-xs', 's': 'text-sm', 'm': 'text-base', 'l': 'text-lg', 'xl': 'text-xl', '2xl': 'text-2xl', '3xl': 'text-3xl' },
  fontWeight: { normal: 'font-normal', medium: 'font-medium', semibold: 'font-semibold', bold: 'font-bold' },
  fontStyle: { italic: 'italic' },
  textDecoration: { underline: 'underline', lineThrough: 'line-through' },
  textColor: {
    muted: 'text-muted',
    dimmed: 'text-dimmed',
    toned: 'text-toned',
    highlighted: 'text-highlighted',
    primary: 'text-primary',
    secondary: 'text-secondary',
    success: 'text-success',
    info: 'text-info',
    warning: 'text-warning',
    error: 'text-error'
  },
  // The wrapper is a column (WidgetRenderer): the text aligns, and so does a block narrower than the box - an upload area, a button.
  align: { start: 'flex flex-col items-start text-left', center: 'flex flex-col items-center text-center', end: 'flex flex-col items-end text-right' },
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
