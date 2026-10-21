import { TotalBaseError } from "@totalbase/errors";

/**
 * A dashboard's tabs (Dashboards.md §7.2, D7): `[{value, label, icon?}]` in order - UTabs' items. None:
 * one grid, as before. A widget's `tab` is one of their values (unset: the first); the App keeps the open one in
 * `?tab=<value>`, so `tab` is no variable's name.
 */
export interface DashboardTab {
  value: string;
  label: string;
  icon?: string;
}

const MAX_TABS = 12;
const VALUE = /^[a-z][a-z0-9_-]{0,31}$/;
const ICON = /^i-[a-z0-9]+(?:-[a-z0-9]+)*$/;

function invalid(message: string): never {
  throw new TotalBaseError("DASHBOARD_TABS_INVALID", message);
}

export function validateTabs(raw: unknown): DashboardTab[] {
  if (!Array.isArray(raw)) invalid('tabs must be a list: [{"value": "summary", "label": "Summary", "icon"?: "i-lucide-..."}].');
  if (raw.length > MAX_TABS) invalid(`A dashboard has at most ${MAX_TABS} tabs.`);
  const seen = new Set<string>();
  return raw.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) invalid(`tabs[${index}] must be an object {value, label, icon?}.`);
    const tab = item as Record<string, unknown>;
    const unknown = Object.keys(tab).filter((k) => !["value", "label", "icon"].includes(k));
    if (unknown.length) invalid(`tabs[${index}] has no "${unknown[0]}" - it takes: value, label, icon.`);
    if (typeof tab.value !== "string" || !VALUE.test(tab.value)) invalid(`tabs[${index}].value must be lowercase letters, digits, _ or -, starting with a letter (max 32) - got ${JSON.stringify(tab.value)}.`);
    if (seen.has(tab.value)) invalid(`tabs[${index}].value "${tab.value}" is repeated.`);
    seen.add(tab.value);
    const label = typeof tab.label === "string" ? tab.label.trim() : "";
    if (!label || label.length > 32) invalid(`tabs[${index}].label is required text, at most 32 characters.`);
    if (tab.icon !== undefined && tab.icon !== null && (typeof tab.icon !== "string" || !ICON.test(tab.icon))) invalid(`tabs[${index}].icon isn't an icon name (i-lucide-chart-bar).`);
    return { value: tab.value, label, ...(typeof tab.icon === "string" ? { icon: tab.icon } : {}) };
  });
}

/** A widget's tab, checked against its dashboard's: one of their values, or null (the first). */
export function validateWidgetTab(raw: unknown, tabs: readonly DashboardTab[]): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (tabs.length === 0) throw new TotalBaseError("DASHBOARD_TABS_INVALID", `This dashboard has no tabs - a widget's tab is unset until it has some (update_dashboard tabs).`);
  if (typeof raw !== "string" || !tabs.some((t) => t.value === raw)) {
    throw new TotalBaseError("DASHBOARD_TABS_INVALID", `No tab "${String(raw)}" - its tabs: ${tabs.map((t) => t.value).join(", ")}.`);
  }
  return raw;
}
