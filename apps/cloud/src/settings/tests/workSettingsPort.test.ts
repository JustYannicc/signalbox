import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { SettingsChange, SettingsSnapshot, SettingsView } from "../WorkSettingsPort.ts";

const decodeChange = Schema.decodeUnknownResult(SettingsChange);
const decodeView = Schema.decodeUnknownResult(SettingsView);
const decodeSnapshot = Schema.decodeUnknownResult(SettingsSnapshot);

const command = {
  type: "settings.patch",
  target: "opaque-target",
  expectedLocalRevision: 0,
  expectedResolution: "opaque-resolution",
  patch: { defaultAutoPull: true },
  clear: [],
};

describe("Catalog work-settings port", () => {
  it("requires both conditional-write tokens with a safe local revision", () => {
    expect(Result.isSuccess(decodeChange(command))).toBe(true);
    const { expectedResolution: _resolution, ...withoutResolution } = command;
    const { expectedLocalRevision: _revision, ...withoutRevision } = command;
    for (const invalid of [
      withoutResolution,
      withoutRevision,
      { ...command, expectedResolution: "" },
      ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1].map((expectedLocalRevision) => ({
        ...command,
        expectedLocalRevision,
      })),
    ]) {
      expect(Result.isFailure(decodeChange(invalid))).toBe(true);
    }
  });

  it("rejects actor, owner-chain and resume fields in the request payload", () => {
    const query = { type: "settings", target: command.target };
    expect(Result.isSuccess(decodeView(query))).toBe(true);
    for (const extra of [{ actor: "someone" }, { chain: ["ancestor"] }, { resume: "cursor" }]) {
      expect(Result.isFailure(decodeView({ ...query, ...extra }))).toBe(true);
      expect(Result.isFailure(decodeChange({ ...command, ...extra }))).toBe(true);
    }
  });

  it("applies the same edit validation before a Catalog change can be submitted", () => {
    for (const edit of [
      { patch: { notificationMode: "all" }, clear: [] },
      { patch: {}, clear: ["defaultAutoPull", "defaultAutoPull"] },
      { patch: { defaultAutoPull: false }, clear: ["defaultAutoPull"] },
    ]) {
      expect(Result.isFailure(decodeChange({ ...command, ...edit }))).toBe(true);
    }
  });

  it("keeps public snapshots free of raw ancestor and future fields", () => {
    const effective = {
      defaultModelSelection: DEFAULT_SERVER_SETTINGS.defaultModelSelection,
      defaultRuntimeMode: DEFAULT_SERVER_SETTINGS.defaultRuntimeMode,
      defaultAutoPull: DEFAULT_SERVER_SETTINGS.defaultAutoPull,
      defaultProjectScripts: DEFAULT_SERVER_SETTINGS.defaultProjectScripts,
    };
    const localPatch = { defaultAutoPull: false };
    const value = Result.getOrThrow(
      decodeSnapshot({
        local: { revision: 2, patch: { ...localPatch, future: "hidden" }, chain: ["hidden"] },
        effective: { ...effective, rawAncestor: "hidden" },
        canWrite: true,
        resolution: command.expectedResolution,
        chain: [{ levelId: "hidden", revision: 3 }],
      }),
    );
    expect(value).toEqual({
      local: { revision: 2, patch: localPatch },
      effective,
      canWrite: true,
      resolution: command.expectedResolution,
    });
  });
});
