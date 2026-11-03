import { describe, expect, it } from "vitest";
import { buildMenuTree, pruneMenu, type MenuModule, type MenuObject } from "./app-menu-service.js";

const dataview = (id: string, name = id): MenuObject => ({ kind: "DATAVIEW", id, name, slug: id, menuLabel: null, description: null, icon: null, color: null, viewType: "TABLE" });
const dashboard = (id: string, name = id): MenuObject => ({ kind: "DASHBOARD", id, name, slug: id, menuLabel: null, description: null, icon: null, color: null, viewType: null });

type Row = Parameters<typeof buildMenuTree>[0][number];
const group = (id: string, name: string, position: number, parent: string | null = null): Row =>
  ({ id, parent, kind: "GROUP", dataview: null, dashboard: null, module: null, name, icon: null, icon_open: null, open_state: "DEFAULT" as const, position });
const moduleRow = (module: MenuModule, position: number, parent: string | null = null): Row =>
  ({ id: module.id, parent, kind: "MODULE", dataview: null, dashboard: null, module: module.module, name: module.name, icon: module.icon, icon_open: null, open_state: "DEFAULT" as const, position });
const users: MenuModule = { kind: "MODULE", id: "m-users", module: "users", name: "Team", icon: null };
const item = (object: MenuObject, position: number, parent: string | null = null): Row => ({
  id: `row-${object.id}`,
  parent,
  kind: object.kind,
  dataview: object.kind === "DATAVIEW" ? object.id : null,
  dashboard: object.kind === "DASHBOARD" ? object.id : null,
  module: null,
  name: null,
  icon: null,
  icon_open: null,
  open_state: "DEFAULT",
  position,
});

describe("buildMenuTree", () => {
  it("starts with everything published at the root, in the order given", () => {
    const a = dataview("a");
    const d = dashboard("d");
    expect(buildMenuTree([], [a, d])).toEqual([a, d]);
  });

  it("follows the stored arrangement and appends unplaced objects to the root", () => {
    const a = dataview("a");
    const b = dataview("b");
    const d = dashboard("d");
    const tree = buildMenuTree([group("g", "Sales", 0), item(b, 0, "g"), item(a, 1)], [a, b, d]);
    expect(tree).toEqual([
      { kind: "GROUP", id: "g", name: "Sales", icon: null, iconOpen: null, openState: "DEFAULT", children: [b] },
      a,
      d,
    ]);
  });

  it("drops an item whose object is no longer published or listed", () => {
    const a = dataview("a");
    expect(buildMenuTree([item(a, 0), item(dataview("gone"), 1)], [a])).toEqual([a]);
  });

  it("nests subgroups and orders siblings by position", () => {
    const a = dataview("a");
    const b = dataview("b");
    const tree = buildMenuTree([group("g", "G", 0), group("s", "Sub", 1, "g"), item(a, 0, "s"), item(b, 0, "g")], [a, b]);
    expect(tree).toEqual([
      { kind: "GROUP", id: "g", name: "G", icon: null, iconOpen: null, openState: "DEFAULT", children: [b, { kind: "GROUP", id: "s", name: "Sub", icon: null, iconOpen: null, openState: "DEFAULT", children: [a] }] },
    ]);
  });

  it("places a module where it was stored, with its own label and icon, and never appends one", () => {
    const a = dataview("a");
    expect(buildMenuTree([group("g", "G", 0), moduleRow(users, 0, "g"), item(a, 1)], [a])).toEqual([
      { kind: "GROUP", id: "g", name: "G", icon: null, iconOpen: null, openState: "DEFAULT", children: [users] },
      a,
    ]);
  });
});

describe("pruneMenu", () => {
  const a = dataview("a");
  const b = dataview("b");
  const d = dashboard("d");
  const tree = buildMenuTree([group("g", "G", 0), group("s", "Sub", 0, "g"), item(a, 0, "s"), item(b, 1), moduleRow(users, 2)], [a, b, d]);

  it("keeps only what the viewer may open - objects by access, modules by their table", () => {
    expect(pruneMenu(tree, (entry) => entry.kind === "DATAVIEW" && entry.id === "b")).toEqual([b]);
    expect(pruneMenu(tree, (entry) => entry.kind === "MODULE" && entry.module === "users")).toEqual([users]);
  });

  it("hides a group left with nothing visible, at any depth", () => {
    const visibleA = pruneMenu(tree, (entry) => entry.id === "a");
    expect(visibleA).toEqual([
      { kind: "GROUP", id: "g", name: "G", icon: null, iconOpen: null, openState: "DEFAULT", children: [{ kind: "GROUP", id: "s", name: "Sub", icon: null, iconOpen: null, openState: "DEFAULT", children: [a] }] },
    ]);
    expect(pruneMenu(tree, () => false)).toEqual([]);
  });

  it("tells a DataView and a Dashboard with the same id apart", () => {
    const sameId = [dataview("x"), dashboard("x")];
    expect(pruneMenu(sameId, (entry) => entry.kind === "DASHBOARD")).toEqual([dashboard("x")]);
  });
});
