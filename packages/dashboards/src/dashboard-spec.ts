import type { DashboardDecision } from "@totalbase/tb-catalog";
import type { DashboardTab } from "./tabs.js";
import type { DashboardVariable } from "./variables.js";

/**
 * A dashboard's draft as one document (Specification_Dashboards.md §10.6, DM2): what `get_dashboard` returns and
 * `apply_dashboard` takes - the same shape both ways, so reading and applying it unchanged changes nothing. Who sees
 * it (its roles and embeds) isn't part of it: that applies at once, not on publishing.
 */
export interface DashboardSpec {
  name: string;
  /** Unset on a new one: from its name. */
  slug?: string | undefined;
  description?: string | null | undefined;
  icon?: string | null | undefined;
  /** The App menu's label - null: its name. */
  menuLabel?: string | null | undefined;
  color?: string | null | undefined;
  scope?: "LISTED" | "EMBEDDED_ONLY" | undefined;
  refreshIntervalSeconds?: number | null | undefined;
  variables?: DashboardVariable[] | undefined;
  tabs?: DashboardTab[] | undefined;
  widgets: DashboardSpecWidget[];
}

export interface DashboardSpecWidget {
  /** This dashboard's widget - kept (clicks, alerts and links point at it); unset: a new one. */
  id?: string | undefined;
  type: string;
  label?: string | null | undefined;
  /** Its tab's value - unset: the first. */
  tab?: string | null | undefined;
  /** Its place on the 12-column canvas - unset: placed in order, at its type's default size. */
  grid?: { x: number; y: number; w: number; h: number } | undefined;
  query?: string | null | undefined;
  config?: Record<string, unknown> | undefined;
}

/** One of a spec's problems: where (`widgets[3].config.roles.value`), its error code, the sentence. */
export interface DashboardSpecError {
  path: string;
  code: string;
  message: string;
}

/** A role's columns as a run decided them (DM3) - chosen in config, or a default by its rule - and why. */
export interface DashboardRoleDecision {
  columns: string[];
  source: "config" | "default";
  rule?: "first-of-kind" | "all-of-kind";
  reason: DashboardDecision;
}

/** JSON with every object's keys sorted - two equal documents read the same, whatever their key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

/** What changed between the draft and a spec (dry_run's answer, the audit's summary). */
export interface DashboardSpecDiff {
  /** The dashboard's own keys that change (name, description, ...). */
  dashboard: string[];
  variables: { added: string[]; removed: string[]; changed: string[] };
  tabs: boolean;
  widgets: {
    /** Each new one by its place in the spec. */
    created: { path: string; type: string; label: string | null }[];
    /** Each kept one whose content changes - which keys. */
    changed: { id: string; label: string | null; keys: string[] }[];
    deleted: { id: string; type: string; label: string | null }[];
  };
}

export function emptyDiff(diff: DashboardSpecDiff): boolean {
  return diff.dashboard.length === 0 && diff.variables.added.length === 0 && diff.variables.removed.length === 0 && diff.variables.changed.length === 0
    && !diff.tabs && diff.widgets.created.length === 0 && diff.widgets.changed.length === 0 && diff.widgets.deleted.length === 0;
}

const DASHBOARD_SPEC_KEYS = ["name", "slug", "description", "icon", "menuLabel", "color", "scope", "refreshIntervalSeconds"] as const;
const WIDGET_SPEC_KEYS = ["type", "label", "tab", "grid", "query", "config"] as const;

/** A spec with nothing left implicit: every key the draft has, so two specs compare key by key. */
type FullWidget = { id?: string | undefined; type: string; label: string | null; tab: string | null; grid: { x: number; y: number; w: number; h: number }; query: string | null; config: Record<string, unknown> };
export interface NormalizedSpec {
  dashboard: Record<(typeof DASHBOARD_SPEC_KEYS)[number], unknown>;
  variables: DashboardVariable[];
  tabs: DashboardTab[];
  widgets: FullWidget[];
}

/** The difference from `current` (the draft) to `next` (a spec, normalized) - widgets matched by id. */
export function diffSpecs(current: NormalizedSpec, next: NormalizedSpec): DashboardSpecDiff {
  const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
  const dashboard = DASHBOARD_SPEC_KEYS.filter((key) => !same(current.dashboard[key], next.dashboard[key]));
  const before = new Map(current.variables.map((v) => [v.name, v]));
  const after = new Map(next.variables.map((v) => [v.name, v]));
  const variables = {
    added: [...after.keys()].filter((name) => !before.has(name)),
    removed: [...before.keys()].filter((name) => !after.has(name)),
    // Its order counts too: the filter bar shows them in it.
    changed: [...after.keys()].filter((name) => before.has(name) && !same(before.get(name), after.get(name))),
  };
  if (variables.added.length === 0 && variables.removed.length === 0 && variables.changed.length === 0 && !same(current.variables.map((v) => v.name), next.variables.map((v) => v.name))) {
    variables.changed = next.variables.map((v) => v.name);
  }
  const kept = new Map(current.widgets.map((w) => [w.id!, w]));
  const created: DashboardSpecDiff["widgets"]["created"] = [];
  const changed: DashboardSpecDiff["widgets"]["changed"] = [];
  next.widgets.forEach((widget, index) => {
    const old = widget.id ? kept.get(widget.id) : undefined;
    if (!old) {
      created.push({ path: `widgets[${index}]`, type: widget.type, label: widget.label });
      return;
    }
    const keys = WIDGET_SPEC_KEYS.filter((key) => !same(old[key], widget[key]));
    if (keys.length) changed.push({ id: old.id!, label: widget.label ?? old.label, keys });
  });
  const named = new Set(next.widgets.map((w) => w.id).filter(Boolean));
  const deleted = current.widgets.filter((w) => !named.has(w.id)).map((w) => ({ id: w.id!, type: w.type, label: w.label }));
  return { dashboard, variables, tabs: !same(current.tabs, next.tabs), widgets: { created, changed, deleted } };
}

/**
 * Places the widgets without a grid (DM2): in order, each at its size, at the first spot - row by row, left to
 * right - where it overlaps nothing placed before it (those with a grid first). Then a row of placed widgets that
 * leaves the end of the canvas empty shares that space between them, so no row ends in a gap.
 */
export function placeWidgets(widgets: { grid?: { x: number; y: number; w: number; h: number } | undefined; size: { w: number; h: number } }[]): { x: number; y: number; w: number; h: number }[] {
  const taken: { x: number; y: number; w: number; h: number }[] = widgets.flatMap((w) => (w.grid ? [w.grid] : []));
  const overlaps = (a: { x: number; y: number; w: number; h: number }, among = taken) => among.some((b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h);
  const placed = widgets.map((widget) => {
    if (widget.grid) return widget.grid;
    const w = Math.min(12, Math.max(1, widget.size.w));
    for (let y = 0; ; y++) {
      for (let x = 0; x + w <= 12; x++) {
        const spot = { x, y, w, h: widget.size.h };
        if (!overlaps(spot)) {
          taken.push(spot);
          return spot;
        }
      }
    }
  });
  const rows = new Map<number, { x: number; y: number; w: number; h: number }[]>();
  widgets.forEach((widget, index) => {
    if (!widget.grid) rows.set(placed[index]!.y, [...(rows.get(placed[index]!.y) ?? []), placed[index]!]);
  });
  for (const row of rows.values()) {
    row.sort((a, b) => a.x - b.x);
    const from = row[0]!.x;
    const end = row.at(-1)!.x + row.at(-1)!.w;
    const contiguous = row.every((spot, i) => i === 0 || spot.x === row[i - 1]!.x + row[i - 1]!.w);
    const others = taken.filter((spot) => !row.includes(spot));
    const area = { x: from, y: row[0]!.y, w: 12 - from, h: Math.max(...row.map((spot) => spot.h)) };
    if (end >= 12 || !contiguous || overlaps(area, others)) continue;
    const gap = 12 - end;
    let x = from;
    row.forEach((spot, i) => {
      spot.x = x;
      spot.w += Math.floor(gap / row.length) + (i >= row.length - (gap % row.length) ? 1 : 0);
      x += spot.w;
    });
  }
  return placed;
}
