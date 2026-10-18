/**
 * Roles + permission matrix (Specification_Admin_UI.md §11.3). Shapes verified live against the
 * running server — PUT/GET responses here are consistently camelCase,
 * unlike the Users list inconsistency noted in types/security.ts.
 */
export type PermissionAction = 'CREATE' | 'READ' | 'UPDATE' | 'DELETE' | 'EXECUTE'
export type PermissionEffect = 'ALLOW' | 'DENY'

/** Which actions apply to a resource depends on its type (Specification.md §11.5: views are read-only). */
export const ACTIONS_BY_RESOURCE_TYPE: Record<'TABLE' | 'VIEW' | 'FUNCTION', PermissionAction[]> = {
  TABLE: ['CREATE', 'READ', 'UPDATE', 'DELETE'],
  VIEW: ['READ'],
  FUNCTION: ['EXECUTE']
}

export interface Role {
  id: string
  name: string
  description: string | null
  icon: string | null
  color: string | null
  active: boolean
  /** The Administrators role: cannot be renamed, deactivated, or deleted. */
  reserved: boolean
  /** How this role's members reach TotalBase - see utils/role-access.ts. adminAccess only on a reserved role. */
  adminAccess: boolean
  appAccess: boolean
  apiAccess: boolean
  createdAt: string
  /** Its App home (Specification_Security.md §8.1) - at most one of the two; grants nothing. */
  homeDataview?: string | null
  homeDashboard?: string | null
  /** Who created it - null for a role an administrator created through the Admin API. Data API only. */
  createdBy?: string | null
}

// Mirrors packages/permissions/src/roles-service.ts's ROLE_ICON_OPTIONS
// exactly - keep both lists in sync by hand (the server validates
// against its own copy regardless, so a drift here is a UX gap, not a
// security one: an option shown here that the server doesn't
// recognize would just get rejected on save).
export const ROLE_ICON_OPTIONS = [
  'i-lucide-shield',
  'i-lucide-shield-check',
  'i-lucide-shield-alert',
  'i-lucide-key',
  'i-lucide-lock',
  'i-lucide-lock-open',
  'i-lucide-crown',
  'i-lucide-users',
  'i-lucide-user',
  'i-lucide-user-cog',
  'i-lucide-user-check',
  'i-lucide-user-plus',
  'i-lucide-user-x',
  'i-lucide-briefcase',
  'i-lucide-building',
  'i-lucide-building-2',
  'i-lucide-store',
  'i-lucide-factory',
  'i-lucide-warehouse',
  'i-lucide-truck',
  'i-lucide-wrench',
  'i-lucide-settings',
  'i-lucide-sliders-horizontal',
  'i-lucide-eye',
  'i-lucide-eye-off',
  'i-lucide-pencil',
  'i-lucide-database',
  'i-lucide-server',
  'i-lucide-cpu',
  'i-lucide-hard-drive',
  'i-lucide-cloud',
  'i-lucide-bot',
  'i-lucide-star',
  'i-lucide-heart',
  'i-lucide-flag',
  'i-lucide-bookmark',
  'i-lucide-tag',
  'i-lucide-tags',
  'i-lucide-folder',
  'i-lucide-folder-open',
  'i-lucide-file-text',
  'i-lucide-clipboard',
  'i-lucide-clipboard-check',
  'i-lucide-calendar',
  'i-lucide-clock',
  'i-lucide-map-pin',
  'i-lucide-globe',
  'i-lucide-compass',
  'i-lucide-send',
  'i-lucide-mail',
  'i-lucide-message-circle',
  'i-lucide-message-square',
  'i-lucide-phone',
  'i-lucide-bell',
  'i-lucide-credit-card',
  'i-lucide-wallet',
  'i-lucide-coins',
  'i-lucide-receipt',
  'i-lucide-shopping-cart',
  'i-lucide-shopping-bag',
  'i-lucide-package',
  'i-lucide-box',
  'i-lucide-plane',
  'i-lucide-car',
  'i-lucide-ship',
  'i-lucide-leaf',
  'i-lucide-sun',
  'i-lucide-moon',
  'i-lucide-zap',
  'i-lucide-flame',
  'i-lucide-activity',
  'i-lucide-stethoscope',
  'i-lucide-microscope',
  'i-lucide-flask-conical',
  'i-lucide-book',
  'i-lucide-book-open',
  'i-lucide-graduation-cap',
  'i-lucide-palette',
  'i-lucide-camera',
  'i-lucide-video',
  'i-lucide-music',
  'i-lucide-headphones',
  'i-lucide-gamepad-2',
  'i-lucide-trophy',
  'i-lucide-target',
  'i-lucide-rocket',
  'i-lucide-satellite',
  'i-lucide-wifi',
  'i-lucide-battery',
  'i-lucide-plug',
  'i-lucide-lightbulb',
  'i-lucide-gauge',
  'i-lucide-filter',
  'i-lucide-search',
  'i-lucide-layers',
  'i-lucide-grid-3x3',
  'i-lucide-list',
  'i-lucide-table',
  'i-lucide-chart-bar',
  'i-lucide-chart-line',
  'i-lucide-pie-chart',
  'i-lucide-trending-up',
  'i-lucide-code',
  'i-lucide-terminal',
  'i-lucide-git-branch',
  'i-lucide-bug',
  'i-lucide-puzzle'
] as const
export const DEFAULT_ROLE_ICON = 'i-lucide-shield'

/**
 * Tailwind's full base palette (17 hues) - the same list Nuxt UI's own
 * dashboard template offers for its "change the app's Primary color"
 * picker (its UserMenu.vue), not this app's 7 semantic tokens
 * (primary/secondary/...) from app.config.ts. A component's `color`
 * prop only resolves those 7 aliases, so a role's color is never
 * passed to one - it's rendered as a raw swatch instead (see
 * ROLE_COLOR_SHADES/roleColorShade below).
 * Mirrors packages/permissions/src/roles-service.ts's ROLE_COLOR_OPTIONS.
 */
export const ROLE_COLOR_OPTIONS = [
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose'
] as const
export type RoleColor = (typeof ROLE_COLOR_OPTIONS)[number]
export const DEFAULT_ROLE_COLOR: RoleColor = 'blue'

/** Real membership check, not just a type assertion - the actual gate `roleColorShade` below (and any caller of a data/formula-driven color, e.g. Map/Calendar's own `colorFormula`) uses to tell a real palette color apart from garbage (a formula that resolved to a raw status string, a hex code, a typo) BEFORE it reaches something that assumes a valid one. */
export function isRoleColor(value: unknown): value is RoleColor {
  return typeof value === 'string' && (ROLE_COLOR_OPTIONS as readonly string[]).includes(value)
}

/** A literal `#rgb`/`#rrggbb` hex string - `WidgetColorSelect.vue`'s own "Custom" tab always normalizes to this exact shape (never `rgb(...)`/`hsl(...)`, even though Nuxt UI's own `UColorPicker` can emit those too) so a color-holding column only ever has ONE non-palette shape to deal with, not several. */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)
}

/** Nuxt UI's semantic colors - what a column presentation's options and a lookup table's color column hold (`info`, `error`). */
const SEMANTIC_COLORS = ['primary', 'secondary', 'success', 'info', 'warning', 'error', 'neutral'] as const
export function isSemanticColor(value: unknown): value is typeof SEMANTIC_COLORS[number] {
  return typeof value === 'string' && (SEMANTIC_COLORS as readonly string[]).includes(value)
}

/** A palette name, a literal hex (the two shapes `WidgetColorSelect.vue` produces) or a Nuxt UI semantic color - the shapes anything reading a color-holding column back (a `colorFormula`, `roleColorShade` below) should treat as legitimately "a color", as opposed to garbage. */
export function isValidColorValue(value: unknown): value is string {
  return isRoleColor(value) || isHexColor(value) || isSemanticColor(value)
}

/** Resolves a role's possibly-unset icon/color to what should actually render. */
export function roleIcon(role: Pick<Role, 'icon'>): string {
  return role.icon ?? DEFAULT_ROLE_ICON
}
export function roleColor(role: Pick<Role, 'color'>): RoleColor {
  return (role.color as RoleColor | null) ?? DEFAULT_ROLE_COLOR
}

/**
 * Tailwind's own default oklch values for each palette color's 400/500
 * shade, copied from `tailwindcss/colors` (v4.3.3) - a static table
 * rather than referencing this project's compiled `--color-<name>-500`
 * CSS variable, because that variable only exists for the 7 colors
 * this app's utility classes actually reference (primary/secondary/...);
 * Tailwind v4 only emits a base-palette color into the final stylesheet
 * for hues a literal utility class uses somewhere in scanned source, and
 * nothing here writes e.g. `bg-teal-500` as a literal class (the name is
 * only ever a runtime string) - ColorDot.vue once rendered blank
 * because of this. Update this table if Tailwind's
 * default palette values ever change.
 */
const ROLE_COLOR_SHADES: Record<RoleColor, { 400: string, 500: string }> = {
  red: { 400: 'oklch(70.4% 0.191 22.216)', 500: 'oklch(63.7% 0.237 25.331)' },
  orange: { 400: 'oklch(75% 0.183 55.934)', 500: 'oklch(70.5% 0.213 47.604)' },
  amber: { 400: 'oklch(82.8% 0.189 84.429)', 500: 'oklch(76.9% 0.188 70.08)' },
  yellow: { 400: 'oklch(85.2% 0.199 91.936)', 500: 'oklch(79.5% 0.184 86.047)' },
  lime: { 400: 'oklch(84.1% 0.238 128.85)', 500: 'oklch(76.8% 0.233 130.85)' },
  green: { 400: 'oklch(79.2% 0.209 151.711)', 500: 'oklch(72.3% 0.219 149.579)' },
  emerald: { 400: 'oklch(76.5% 0.177 163.223)', 500: 'oklch(69.6% 0.17 162.48)' },
  teal: { 400: 'oklch(77.7% 0.152 181.912)', 500: 'oklch(70.4% 0.14 182.503)' },
  cyan: { 400: 'oklch(78.9% 0.154 211.53)', 500: 'oklch(71.5% 0.143 215.221)' },
  sky: { 400: 'oklch(74.6% 0.16 232.661)', 500: 'oklch(68.5% 0.169 237.323)' },
  blue: { 400: 'oklch(70.7% 0.165 254.624)', 500: 'oklch(62.3% 0.214 259.815)' },
  indigo: { 400: 'oklch(67.3% 0.182 276.935)', 500: 'oklch(58.5% 0.233 277.117)' },
  violet: { 400: 'oklch(70.2% 0.183 293.541)', 500: 'oklch(60.6% 0.25 292.717)' },
  purple: { 400: 'oklch(71.4% 0.203 305.504)', 500: 'oklch(62.7% 0.265 303.9)' },
  fuchsia: { 400: 'oklch(74% 0.238 322.16)', 500: 'oklch(66.7% 0.295 322.15)' },
  pink: { 400: 'oklch(71.8% 0.202 349.761)', 500: 'oklch(65.6% 0.241 354.308)' },
  rose: { 400: 'oklch(71.2% 0.194 13.428)', 500: 'oklch(64.5% 0.246 16.439)' }
}

/**
 * The actual oklch color to paint `color` with - shade 400 in dark mode
 * (lighter, for contrast on a dark background), 500 in light mode,
 * matching Nuxt UI's own convention for its theme colors.
 *
 * Takes a plain `string`, not `RoleColor` - every OTHER caller here
 * (ColorDot.vue, ColorPickerField.vue, role management) already only
 * ever passes a real, UI-picked `RoleColor`, but Map/Calendar's own
 * `colorFormula` hands this whatever a BUILDER's formula (or the raw row
 * data itself) evaluated to - a `{{status}}` binding returning "PENDING"
 * instead of a real palette name is a realistic, easy mistake, not a
 * hypothetical one. This never throws regardless: an unrecognized string
 * returns `'transparent'` (a real, always-valid CSS color) instead of
 * `ROLE_COLOR_SHADES[color]` being `undefined` and the `[400|500]` index
 * one line down throwing "Cannot read properties of undefined" -
 * `'transparent'` is deliberately not just "another safe default" like
 * `DEFAULT_ROLE_COLOR`'s own blue would be - callers that want a
 * BUILDER to actually notice their formula returned garbage (Map/
 * Calendar's own pin/chip render) pair it with a visibly-broken outline,
 * not a color that could pass for an intentional pick.
 *
 * A literal hex (`isHexColor`) passes through AS-IS instead of hitting
 * that `'transparent'` fallback - `WidgetColorSelect.vue`'s own "Custom"
 * tab stores one, and it's just as real a color as a palette name, only
 * without that name's own light/dark-mode-aware shade (an inherent
 * tradeoff of picking one exact, fixed color instead of a semantic one -
 * there's no "the dark-mode version of #3a7bd5" to compute).
 */
export function roleColorShade(color: string, mode: 'light' | 'dark'): string {
  if (isRoleColor(color)) return ROLE_COLOR_SHADES[color][mode === 'dark' ? 400 : 500]
  if (isHexColor(color)) return color
  // The theme's own, already light/dark-aware (B55: a Gantt lane colored `info` drew its bars transparent).
  if (isSemanticColor(color)) return color === 'neutral' ? 'var(--ui-color-neutral-400)' : `var(--ui-${color})`
  return 'transparent'
}

/**
 * Why a column can never be granted - a locale key, translated where shown -
 * or undefined if it isn't protected. The catalog detail says which columns
 * the server never exposes through the Data API whatever a field grant says
 * (`protected`, from @totalbase/mutations' guardrails); the checklist shows
 * them disabled with an explanatory tooltip rather than silently missing.
 */
export function protectedFieldReason(column: Pick<CatalogColumn, 'protected'>): string | undefined {
  return column.protected ? 'users.permissionEditor.protectedField' : undefined
}

export interface FieldGrant {
  field: string
  effect: PermissionEffect
}

/**
 * `where` uses the same filter-object shape as the Data API's `where[...]`
 * query parameters (Specification_Data_API.md §3.1, §3.10). We treat it as an opaque
 * JSON value here — building a visual filter builder against that full
 * grammar is out of scope for this pass (a raw JSON editor with validation
 * is the pragmatic v1; see the note in roles/[id].vue).
 */
export type FilterObject = Record<string, unknown>

/**
 * "Payload checks" (totalbase.permissions.payload_checks) - a role-scoped
 * CREATE/UPDATE business-rule check, evaluated against the resulting row.
 * Deliberately NOT a PostgreSQL CHECK constraint - a real CHECK is global
 * (applies to every writer, no matter who); this only applies to writes
 * made by a role holding this grant, and only through TotalBase's own
 * write paths (bypassed entirely by SQL Console or an external script -
 * it complements a DB-level CHECK, not a substitute for one). `rule`
 * shares the exact same grammar as `where` (see FilterObject above) -
 * one grammar, three uses: the Data API's own where[...] params, a
 * permission's row filter, and this.
 */
export interface PayloadCheck {
  rule: FilterObject
  label: string | null
}

export interface Permission {
  id: string
  role: string
  resource: string
  action: PermissionAction
  effect: PermissionEffect
  whereClause: FilterObject | null
  fields: FieldGrant[]
  payloadChecks: PayloadCheck[]
}

export interface PermissionPutBody {
  effect: PermissionEffect
  where?: FilterObject | null
  fields?: FieldGrant[]
  payloadChecks?: PayloadCheck[]
}

export interface CatalogColumn {
  /** pg_attribute.attnum - stable across a rename, unlike `name`. DataView field bindings key on this (Specification_DataViews.md §1.2). */
  attnum: number
  name: string
  dataType: string
  /** The type alone (`character varying`, `numeric`, `text[]`) and its declared length / precision / scale - the catalog's, never parsed out of `dataType` here. A column synthesized for a formula (a computed column's, a variable's) has none. */
  typeName?: string
  typeLength?: number | null
  typePrecision?: number | null
  typeScale?: number | null
  /** The domain the column is declared with (`cuit`) - then `dataType` and the parts are its base type's; null for a plain type. */
  domain?: string | null
  nullable: boolean
  isIdentity: boolean
  isGenerated: boolean
  defaultExpression: string | null
  /** Never readable or writable through the Data API whatever a grant says (the server's guardrails) - on a table's or a view's detail. */
  protected?: boolean
  /** What the caller titles it - a DataView's column title - shown instead of `name` where one is picked (the filter's Builder). Never the catalog's. */
  label?: string
  /** Where its possible values come from, when the caller knows - the filter's Builder then picks `=`, `≠` and `in` values from them instead of a typed one. */
  values?: ColumnValueSource
}

/**
 * A column's possible values: a fixed list (a CHECK `IN (...)`, its values' labels the column's presentation), or the
 * rows of the table a foreign key points at, shown by that table's row presentation (Specification_DataViews.md §15.5).
 */
export type ColumnValueSource
  = | { kind: 'list', items: { value: string, label: string }[] }
    | { kind: 'relation', schema: string, table: string, column: string, display: { display_field?: string, display_template?: string } }
