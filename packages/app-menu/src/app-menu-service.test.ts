import { describe, expect, it } from "vitest";
import { buildMenuTree, pruneMenu, type MenuObject } from "./app-menu-service.js";

const dataview = (id: string, name = id): MenuObject => ({ kind: "DATAVIEW", id, name, slug: id, menuLabel: null, description: null, icon: null, color: null, viewType: "TABLE" });
const dashboard = (id: string, name = id): MenuObject => ({ kind: "DASHBOARD", id, name, slug: id, menuLabel: null, description: null, icon: null, color: null, viewType: null });

type Row = Parameters<typeof buildMenuTree>[0][number];
const group = (id: string, name: string, position: number, parent: string | null = null): Row =>
  ({ id, parent, kind: "GROUP", dataview: null, dashboard: null, name, icon: null, icon_open: null, open_state: "DEFAULT" as const, position });
const item = (object: MenuObject, position: number, parent: string | null = null): Row => ({
  id: `row-${object.id}`,
  parent,
  kind: object.kind,
  dataview: object.kind === "DATAVIEW" ? object.id : null,
  dashboard: object.kind === "DASHBOARD" ? object.id : null,
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
});

describe("pruneMenu", () => {
  const a = dataview("a");
  const b = dataview("b");
  const d = dashboard("d");
  const tree = buildMenuTree([group("g", "G", 0), group("s", "Sub", 0, "g"), item(a, 0, "s"), item(b, 1)], [a, b, d]);

  it("keeps only what the viewer may open", () => {
    expect(pruneMenu(tree, (kind, id) => kind === "DATAVIEW" && id === "b")).toEqual([b]);
  });

  it("hides a group left with nothing visible, at any depth", () => {
    const visibleA = pruneMenu(tree, (_kind, id) => id === "a");
    expect(visibleA).toEqual([
      { kind: "GROUP", id: "g", name: "G", icon: null, iconOpen: null, openState: "DEFAULT", children: [{ kind: "GROUP", id: "s", name: "Sub", icon: null, iconOpen: null, openState: "DEFAULT", children: [a] }] },
    ]);
    expect(pruneMenu(tree, () => false)).toEqual([]);
  });

  it("tells a DataView and a Dashboard with the same id apart", () => {
    const sameId = [dataview("x"), dashboard("x")];
    expect(pruneMenu(sameId, (kind) => kind === "DASHBOARD")).toEqual([dashboard("x")]);
  });
});
