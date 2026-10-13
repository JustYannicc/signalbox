import { describe, expect, it } from "vite-plus/test";

import { TOP_LEVEL } from "../levels/levels";
import { DEFAULTS_PRESETS } from "./defaultsFixtures";
import { inheritedPreset, resolvePreset, type DefaultsPreset } from "./defaultsModel";

const NORTHWIND = "section:work-northwind";
const PORTAL = "team-project:merchant-portal";

const find = (presets: readonly DefaultsPreset[], level: string) =>
  presets.find((preset) => preset.level === level)!;

const item = (id: string) => ({ id, kind: "skills" as const, name: id, detail: "" });
const preset = (level: string, items: string[], removes: string[] = []): DefaultsPreset => ({
  id: level,
  level,
  name: level,
  items: items.map(item),
  removes,
});

describe("resolvePreset", () => {
  it("starts a team project from its team's preset and shows its overrides", () => {
    const resolved = resolvePreset(find(DEFAULTS_PRESETS, PORTAL), DEFAULTS_PRESETS);
    expect(resolved.parent?.level).toBe(NORTHWIND);
    const figma = resolved.items.find((entry) => entry.item.id === "plugin:figma");
    expect(figma?.origin).toBe("removed");
    expect(resolved.items.some((entry) => entry.origin === "added")).toBe(true);
  });

  it("inherits the nearest preset above, skipping levels without one", () => {
    const presets = [
      preset(TOP_LEVEL, ["everyone"]),
      preset(NORTHWIND, ["team"], ["everyone"]),
      preset(PORTAL, ["portal"]),
    ];
    // Work has no preset, so Northwind starts from the top level's.
    expect(inheritedPreset(find(presets, NORTHWIND), presets)?.level).toBe(TOP_LEVEL);
    expect(inheritedPreset(find(presets, TOP_LEVEL), presets)).toBeUndefined();
    // What Northwind removed stays removed for the projects inside it.
    const portal = resolvePreset(find(presets, PORTAL), presets);
    expect(portal.items.map((entry) => [entry.item.id, entry.origin])).toEqual([
      ["team", "inherited"],
      ["portal", "added"],
    ]);
  });
});
