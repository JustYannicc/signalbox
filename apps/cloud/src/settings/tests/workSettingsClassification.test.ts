import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import { applyWorkSettingsEdit, classifyWorkSettings } from "../WorkSettings.ts";

const defaults = {
  defaultModelSelection: DEFAULT_SERVER_SETTINGS.defaultModelSelection,
  defaultRuntimeMode: DEFAULT_SERVER_SETTINGS.defaultRuntimeMode,
  defaultAutoPull: DEFAULT_SERVER_SETTINGS.defaultAutoPull,
  defaultProjectScripts: DEFAULT_SERVER_SETTINGS.defaultProjectScripts,
};
const corruptPatches = [
  { defaultAutoPull: null },
  { defaultRuntimeMode: "secret-sentinel" },
  { defaultModelSelection: { options: [] } },
  { defaultProjectScripts: [{ id: "secret-sentinel" }] },
];

describe("work settings classification", () => {
  it("treats a root as local settings with zero ancestor contributions", () => {
    expect(classifyWorkSettings([{}])).toEqual({
      _tag: "Ready",
      local: {},
      effective: defaults,
    });
    expect(classifyWorkSettings([{ defaultAutoPull: null }])).toEqual({
      _tag: "LocalRepairRequired",
    });
    expect(classifyWorkSettings([{ defaultAutoPull: true }])).toEqual({
      _tag: "Ready",
      local: { defaultAutoPull: true },
      effective: { ...defaults, defaultAutoPull: true },
    });
  });

  it("returns only declared local and fully resolved effective values when ready", () => {
    const root = Object.freeze({
      defaultModelSelection: { instanceId: "team", model: "ancestor" },
      defaultRuntimeMode: "approval-required",
      defaultAutoPull: true,
      ancestorId: "secret-sentinel",
      resolution: "secret-sentinel",
    });
    const local = Object.freeze({
      defaultModelSelection: null,
      defaultAutoPull: false,
      future: { secret: "secret-sentinel" },
      canWrite: true,
    });
    expect(classifyWorkSettings([root, {}, local])).toEqual({
      _tag: "Ready",
      local: { defaultModelSelection: null, defaultAutoPull: false },
      effective: {
        ...defaults,
        defaultModelSelection: null,
        defaultRuntimeMode: "approval-required",
        defaultAutoPull: false,
      },
    });
  });

  it.each(corruptPatches)("exposes no values or authority for corrupt local settings %j", (bad) => {
    expect(
      classifyWorkSettings([
        { defaultAutoPull: true },
        { ...bad, revision: 42, resolution: "secret-sentinel", canWrite: true },
      ]),
    ).toEqual({ _tag: "LocalRepairRequired" });
  });

  it.each(corruptPatches)(
    "lets corrupt ancestors take precedence over any local state %j",
    (bad) => {
      const ancestor = { ...bad, ancestorId: "secret-sentinel" };
      for (const local of [
        {},
        { defaultModelSelection: null, defaultAutoPull: true },
        ...corruptPatches,
      ]) {
        expect(classifyWorkSettings([ancestor, {}, local])).toEqual({
          _tag: "InheritedUnavailable",
        });
        expect(classifyWorkSettings([{}, ancestor, local])).toEqual({
          _tag: "InheritedUnavailable",
        });
      }
    },
  );

  it("returns Ready after local clear or replacement repairs, keeping inherited values", () => {
    const root = { defaultAutoPull: true };
    const local = { defaultAutoPull: null, future: "secret-sentinel" };
    for (const edit of [{ clear: ["defaultAutoPull"] }, { patch: { defaultAutoPull: false } }]) {
      const repaired = Result.getOrThrow(applyWorkSettingsEdit(local, edit));
      const patch = "patch" in edit ? edit.patch : {};
      expect(classifyWorkSettings([root, repaired.rawLocal])).toEqual({
        _tag: "Ready",
        local: patch,
        effective: { ...defaults, defaultAutoPull: true, ...patch },
      });
    }
    expect(local.defaultAutoPull).toBeNull();
  });

  it("reclassifies after ancestor repair and chain changes without caching partial values", () => {
    const ancestor = { defaultAutoPull: null, future: "secret-sentinel" };
    const local = { defaultModelSelection: null };
    expect(classifyWorkSettings([ancestor, local])).toEqual({ _tag: "InheritedUnavailable" });
    const repaired = Result.getOrThrow(
      applyWorkSettingsEdit(ancestor, { patch: { defaultAutoPull: true } }),
    );
    expect(classifyWorkSettings([repaired.rawLocal, local])).toEqual({
      _tag: "Ready",
      local,
      effective: { ...defaults, defaultModelSelection: null, defaultAutoPull: true },
    });
    expect(classifyWorkSettings([local])).toEqual({
      _tag: "Ready",
      local,
      effective: { ...defaults, defaultModelSelection: null },
    });
    expect(classifyWorkSettings([ancestor, local])).toEqual({ _tag: "InheritedUnavailable" });
  });
});
