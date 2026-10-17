import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  applyWorkSettingsEdit,
  DeclaredWorkPatch,
  EffectiveWorkSettings,
  foldWorkSettings,
  readDeclaredWorkPatch,
  WorkSettingKey,
  WorkSettingsEditPatch,
  WorkSettingsPolicyError,
} from "../WorkSettings.ts";

const script = {
  id: "test",
  name: "Tests",
  command: "vp test",
  icon: "test",
  runOnWorktreeCreate: false,
} as const;
const model = { instanceId: "team", model: "chosen" } as const;
const success = Result.getOrThrow;
const decodeDeclaredWorkPatch = Schema.decodeUnknownResult(DeclaredWorkPatch);
const decodeEffectiveWorkSettings = Schema.decodeUnknownResult(EffectiveWorkSettings);
const decodeWorkSettingsEditPatch = Schema.decodeUnknownResult(WorkSettingsEditPatch);
const decodeWorkSettingKey = Schema.decodeUnknownResult(WorkSettingKey);
const expectFailure = (result: Result.Result<unknown, WorkSettingsPolicyError>) => {
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure).toBeInstanceOf(WorkSettingsPolicyError);
    expect(result.failure.message).not.toContain("secret-sentinel");
    expect(JSON.stringify(result.failure)).not.toContain("secret-sentinel");
  }
};

describe("work settings policy", () => {
  it("uses only the four product defaults, without a personal driver/model fallback", () => {
    const expected = {
      defaultModelSelection: DEFAULT_SERVER_SETTINGS.defaultModelSelection,
      defaultRuntimeMode: DEFAULT_SERVER_SETTINGS.defaultRuntimeMode,
      defaultAutoPull: DEFAULT_SERVER_SETTINGS.defaultAutoPull,
      defaultProjectScripts: DEFAULT_SERVER_SETTINGS.defaultProjectScripts,
    };
    expect(success(foldWorkSettings([]))).toEqual(expected);
    expect(
      success(
        foldWorkSettings([
          {
            personalModelSelection: model,
            defaultProvider: "codex",
            providerInstances: { codex: {} },
          },
        ]),
      ),
    ).toEqual(expected);
  });

  it("takes the nearest explicit whole key in root-to-target order", () => {
    const root = {
      defaultModelSelection: { ...model, options: [{ id: "effort", value: "high" }] },
      defaultRuntimeMode: "approval-required",
      defaultAutoPull: true,
      defaultProjectScripts: [script],
    };
    const ancestor = {
      defaultModelSelection: { instanceId: "other", model: "ancestor" },
      defaultAutoPull: false,
    };
    const child = { defaultProjectScripts: [] };
    expect(success(foldWorkSettings([root, ancestor, child]))).toEqual({
      defaultModelSelection: ancestor.defaultModelSelection,
      defaultRuntimeMode: "approval-required",
      defaultAutoPull: false,
      defaultProjectScripts: [],
    });
  });

  it("lets null block inheritance and whole-key clear reveal the ancestor", () => {
    const ancestor = { defaultModelSelection: model, defaultAutoPull: true };
    const local = { defaultModelSelection: null, defaultAutoPull: false, future: { keep: true } };
    expect(success(foldWorkSettings([ancestor, local])).defaultModelSelection).toBeNull();
    const result = success(
      applyWorkSettingsEdit(local, {
        clear: ["defaultModelSelection", "defaultAutoPull"],
      }),
    );
    expect(result).toEqual({ rawLocal: { future: { keep: true } }, changed: true });
    expect(success(foldWorkSettings([ancestor, result.rawLocal]))).toMatchObject(ancestor);
    expect(local.defaultModelSelection).toBeNull();
  });

  it("merges model/option record patches only into local raw values", () => {
    const local = Object.freeze({
      defaultModelSelection: Object.freeze({
        ...model,
        options: Object.freeze({ effort: "high", fast: false, future: { opaque: true } }),
        future: Object.freeze({ opaque: [1, 2] }),
      }),
      defaultProjectScripts: Object.freeze([
        Object.freeze({ ...script, future: { opaque: true } }),
      ]),
      future: Object.freeze({ opaque: true }),
    });
    const patch = Object.freeze({
      defaultModelSelection: Object.freeze({
        options: Object.freeze({ fast: true }),
      }),
    });
    const result = success(applyWorkSettingsEdit(local, { patch }));
    expect(result.changed).toBe(true);
    expect(result.rawLocal).toEqual({
      ...local,
      defaultModelSelection: {
        ...local.defaultModelSelection,
        options: { effort: "high", fast: true, future: { opaque: true } },
      },
    });
    expect(local.defaultModelSelection.options.fast).toBe(false);
    expect(patch.defaultModelSelection.options).toEqual({ fast: true });
    expect(success(readDeclaredWorkPatch(result.rawLocal)).defaultModelSelection).toEqual({
      ...model,
      options: [
        { id: "effort", value: "high" },
        { id: "fast", value: true },
      ],
    });
  });

  it("preserves raw model, script-array and top-level extras on an unrelated edit", () => {
    const local = {
      defaultModelSelection: { ...model, future: { secret: "secret-sentinel" } },
      defaultProjectScripts: [{ ...script, future: { secret: "secret-sentinel" } }],
      future: { secret: "secret-sentinel" },
    };
    const before = JSON.stringify(local);
    expect(
      success(applyWorkSettingsEdit(local, { patch: { defaultAutoPull: true } })).rawLocal,
    ).toEqual({ ...local, defaultAutoPull: true });
    expect(JSON.stringify(local)).toBe(before);
  });

  it("never borrows ancestor fields to complete a partial local model", () => {
    const ancestor = { defaultModelSelection: model };
    expect(success(foldWorkSettings([ancestor, {}])).defaultModelSelection).toEqual(model);
    for (const local of [{}, { defaultModelSelection: null }]) {
      expectFailure(
        applyWorkSettingsEdit(local, {
          patch: { defaultModelSelection: { options: { fast: true } } },
        }),
      );
      expectFailure(
        applyWorkSettingsEdit(local, {
          patch: { defaultModelSelection: { model: "secret-sentinel" } },
        }),
      );
    }
    expect(
      success(applyWorkSettingsEdit({}, { patch: { defaultModelSelection: model } })).changed,
    ).toBe(true);
  });

  it("validates complete local values after patching and does not mutate on failure", () => {
    const local = { defaultModelSelection: model, defaultAutoPull: false };
    const before = JSON.stringify(local);
    expectFailure(
      applyWorkSettingsEdit(local, {
        patch: {
          defaultAutoPull: true,
          defaultModelSelection: { instanceId: "bad/secret-sentinel" },
        },
      }),
    );
    expect(JSON.stringify(local)).toBe(before);
    expect(
      success(applyWorkSettingsEdit(local, { patch: { defaultModelSelection: null } })).rawLocal,
    ).toEqual({ ...local, defaultModelSelection: null });
  });

  it("replaces script and option arrays rather than merging their elements", () => {
    const local = {
      defaultProjectScripts: [
        { ...script, future: true },
        { ...script, id: "second" },
      ],
      defaultModelSelection: { ...model, options: [{ id: "fast", value: true, future: true }] },
    };
    const replacement = [{ ...script, id: "new" }];
    const result = success(
      applyWorkSettingsEdit(local, {
        patch: {
          defaultProjectScripts: replacement,
          defaultModelSelection: { options: [{ id: "effort", value: "low" }] },
        },
      }),
    );
    expect(result.rawLocal).toEqual({
      defaultProjectScripts: replacement,
      defaultModelSelection: { ...model, options: [{ id: "effort", value: "low" }] },
    });
    expect(local.defaultProjectScripts).toHaveLength(2);
    expectFailure(
      applyWorkSettingsEdit(local, { patch: { defaultProjectScripts: [{ id: "new" }] } }),
    );
    expect(
      success(
        applyWorkSettingsEdit(local, {
          patch: { defaultModelSelection: { model: "updated" } },
        }),
      ).rawLocal,
    ).toEqual({
      ...local,
      defaultModelSelection: {
        ...local.defaultModelSelection,
        model: "updated",
      },
    });
    expect(
      success(
        applyWorkSettingsEdit(local, {
          patch: { defaultModelSelection: { options: { effort: "low" } } },
        }),
      ).rawLocal,
    ).toEqual({
      ...local,
      defaultModelSelection: {
        ...model,
        options: { effort: "low" },
      },
    });
  });

  it("strips unknown fields from declared and effective DTOs, including array records", () => {
    const raw = {
      defaultModelSelection: {
        ...model,
        options: [{ id: "fast", value: true, secret: "secret-sentinel" }],
        secret: "secret-sentinel",
      },
      defaultProjectScripts: [{ ...script, secret: "secret-sentinel" }],
      ancestorId: "secret-sentinel",
      revision: 42,
      chain: ["secret-sentinel"],
    };
    const declared = success(readDeclaredWorkPatch(raw));
    expect(declared).toEqual({
      defaultModelSelection: { ...model, options: [{ id: "fast", value: true }] },
      defaultProjectScripts: [script],
    });
    expect(success(decodeDeclaredWorkPatch(raw))).toEqual(declared);
    const effective = success(foldWorkSettings([raw]));
    expect(JSON.stringify(effective)).not.toContain("secret-sentinel");
    expect(success(decodeEffectiveWorkSettings({ ...effective, ...raw }))).toEqual(effective);
  });

  it("fails explicitly for invalid stored declarations even when a child overrides them", () => {
    for (const invalid of [
      { defaultAutoPull: null },
      { defaultRuntimeMode: "secret-sentinel" },
      { defaultModelSelection: { options: [] } },
      { defaultProjectScripts: [{ id: "broken" }] },
    ]) {
      expectFailure(readDeclaredWorkPatch(invalid));
      expectFailure(
        foldWorkSettings([invalid, { defaultAutoPull: true, defaultModelSelection: null }]),
      );
      const edit = applyWorkSettingsEdit(invalid, {});
      expectFailure(edit);
      if (Result.isFailure(edit)) expect(edit.failure.reason).toBe("invalid-edit");
    }
  });

  it("rejects unknown, personal, host and undecided writes, including nested future fields", () => {
    for (const patch of [
      { future: true },
      { responseStreamingMode: "paragraph" },
      { defaultProvider: "codex" },
      { providerInstances: {} },
      { serverPort: 1234 },
      { textGenerationModelSelection: model },
      { defaultModelSelection: { future: true } },
      { defaultModelSelection: { provider: "codex" } },
      { defaultModelSelection: { options: [{ id: "fast", value: true, future: true }] } },
      { defaultProjectScripts: [{ ...script, future: true }] },
    ]) {
      expect(Result.isFailure(decodeWorkSettingsEditPatch(patch))).toBe(true);
      const local = Object.freeze({ defaultAutoPull: false });
      expectFailure(applyWorkSettingsEdit(local, { patch }));
      expect(local).toEqual({ defaultAutoPull: false });
    }
    expect(Result.isFailure(decodeWorkSettingKey("future"))).toBe(true);
  });

  it("rejects duplicate clears, unknown clears, nested clears, overlap and wrong types atomically", () => {
    for (const edit of [
      { clear: ["defaultAutoPull", "defaultAutoPull"] },
      { clear: ["future"] },
      { clear: ["defaultModelSelection.options"] },
      { clear: ["defaultAutoPull"], patch: { defaultAutoPull: true } },
      { clear: ["defaultModelSelection"], patch: { defaultModelSelection: null } },
      { patch: { defaultAutoPull: "true" } },
      { patch: { defaultRuntimeMode: null } },
      { patch: { defaultProjectScripts: null } },
      { patch: { defaultAutoPull: null } },
      { patch: { defaultModelSelection: { options: { fast: 1 } } } },
      { patch: { defaultModelSelection: { options: { "": true } } } },
      { patch: { defaultModelSelection: { options: { "   ": true } } } },
      { patch: {}, future: "secret-sentinel" },
      { patch: null },
      { clear: null },
    ]) {
      const local = Object.freeze({ defaultAutoPull: false, defaultModelSelection: model });
      expectFailure(applyWorkSettingsEdit(local, edit));
      expect(local).toEqual({ defaultAutoPull: false, defaultModelSelection: model });
    }
  });

  it("treats absent edits, absent clears and equal reordered objects as no-ops", () => {
    const local = { defaultModelSelection: { ...model, options: { fast: true, effort: "low" } } };
    for (const edit of [
      {},
      { patch: {} },
      { clear: ["defaultAutoPull"] },
      {
        patch: {
          defaultModelSelection: {
            model: "chosen",
            instanceId: "team",
            options: { effort: "low", fast: true },
          },
        },
      },
    ]) {
      const result = success(applyWorkSettingsEdit(local, edit));
      expect(result).toEqual({ rawLocal: local, changed: false });
      expect(result.rawLocal).toBe(local);
    }
    const once = success(applyWorkSettingsEdit(local, { patch: { defaultAutoPull: true } }));
    expect(once.changed).toBe(true);
    expect(
      success(applyWorkSettingsEdit(once.rawLocal, { patch: { defaultAutoPull: true } })).changed,
    ).toBe(false);
  });

  it("keeps option record semantics and accepts legacy stored model codecs", () => {
    const legacy = {
      defaultModelSelection: {
        provider: "codex",
        model: "legacy",
        options: { fast: true, ignored: 7 },
      },
    };
    expect(success(readDeclaredWorkPatch(legacy)).defaultModelSelection).toEqual({
      instanceId: "codex",
      model: "legacy",
      options: [{ id: "fast", value: true }],
    });
    expect(
      success(
        applyWorkSettingsEdit(legacy, {
          patch: {
            defaultModelSelection: { options: { fast: false } },
          },
        }),
      ).rawLocal,
    ).toEqual({
      defaultModelSelection: {
        ...legacy.defaultModelSelection,
        options: { fast: false, ignored: 7 },
      },
    });
  });

  it("rejects inherited properties, accessors, cycles and non-JSON values without invoking getters", () => {
    let reads = 0;
    const accessor = Object.defineProperty({}, "defaultAutoPull", {
      enumerable: true,
      get: () => {
        reads++;
        return true;
      },
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const sparse: Array<unknown> = [];
    sparse.length = 1;
    for (const input of [
      Object.create({ defaultAutoPull: true }),
      accessor,
      { future: undefined },
      { future: NaN },
      { future: Infinity },
      { future: BigInt(1) },
      { future: Symbol() },
      { future: () => true },
      { future: new Date(0) },
      { future: cycle },
      { future: sparse },
      { [Symbol()]: true },
    ]) {
      expectFailure(readDeclaredWorkPatch(input));
      expectFailure(applyWorkSettingsEdit({}, { patch: input }));
    }
    expect(reads).toBe(0);
  });

  it("uses own records safely for prototype-like option ids without polluting prototypes", () => {
    const options = { ["__proto__"]: true, constructor: false, prototype: "allowed-option-id" };
    const local = { defaultModelSelection: { ...model, options: {} } };
    const result = success(
      applyWorkSettingsEdit(local, { patch: { defaultModelSelection: { options } } }),
    );
    expect(result.rawLocal).toEqual({ defaultModelSelection: { ...model, options } });
    expect(Object.getPrototypeOf(result.rawLocal)).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, "allowed-option-id")).toBe(false);
    expectFailure(applyWorkSettingsEdit(local, { patch: { ["__proto__"]: { polluted: true } } }));
  });

  it("accepts null-prototype own records and rejects sparse arrays carrying extra named fields", () => {
    const raw = { defaultAutoPull: false, future: { keep: true } };
    Object.setPrototypeOf(raw, null);
    expect(
      success(applyWorkSettingsEdit(raw, { patch: { defaultAutoPull: true } })).rawLocal,
    ).toEqual({ defaultAutoPull: true, future: { keep: true } });
    const sparse: Array<unknown> = [];
    sparse.length = 1;
    Object.defineProperty(sparse, "extra", { value: true, enumerable: true });
    expectFailure(readDeclaredWorkPatch({ future: sparse }));
  });
});
