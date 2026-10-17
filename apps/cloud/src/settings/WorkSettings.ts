import {
  ModelSelection,
  ProjectScript,
  ProviderInstanceId,
  RuntimeMode,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  equalJson,
  isJsonRecord,
  isStoredRecord,
  mergeLocalJson,
  OwnJson,
  strictJsonCodec,
} from "./internal/workSettingsJson.ts";

const keys = [
  "defaultModelSelection",
  "defaultRuntimeMode",
  "defaultAutoPull",
  "defaultProjectScripts",
] as const;

export const WorkSettingKey = Schema.Literals(keys);
export type WorkSettingKey = typeof WorkSettingKey.Type;

const declaredFields = {
  defaultModelSelection: Schema.NullOr(ModelSelection),
  defaultRuntimeMode: RuntimeMode,
  defaultAutoPull: Schema.Boolean,
  defaultProjectScripts: Schema.Array(ProjectScript),
};

export const EffectiveWorkSettings = OwnJson.pipe(Schema.decodeTo(Schema.Struct(declaredFields)));
export type EffectiveWorkSettings = typeof EffectiveWorkSettings.Type;

export const DeclaredWorkPatch = OwnJson.pipe(
  Schema.decodeTo(
    Schema.Struct({
      defaultModelSelection: Schema.optionalKey(declaredFields.defaultModelSelection),
      defaultRuntimeMode: Schema.optionalKey(declaredFields.defaultRuntimeMode),
      defaultAutoPull: Schema.optionalKey(declaredFields.defaultAutoPull),
      defaultProjectScripts: Schema.optionalKey(declaredFields.defaultProjectScripts),
    }),
  ),
);
export type DeclaredWorkPatch = typeof DeclaredWorkPatch.Type;

const OptionStringEdit = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty());
const OptionValueEdit = Schema.Union([OptionStringEdit, Schema.Boolean]);

// Only record-to-record options merge by id; arrays and array/record crossings replace whole values.
const OptionsEdit = Schema.Union([
  Schema.Array(Schema.Struct({ id: OptionStringEdit, value: OptionValueEdit })),
  Schema.Record(OptionStringEdit, OptionValueEdit),
]);
const ModelEdit = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  options: Schema.optionalKey(OptionsEdit),
});

export const WorkSettingsEditPatch = strictJsonCodec(
  Schema.Struct({
    defaultModelSelection: Schema.optionalKey(Schema.NullOr(ModelEdit)),
    defaultRuntimeMode: Schema.optionalKey(RuntimeMode),
    defaultAutoPull: Schema.optionalKey(Schema.Boolean),
    defaultProjectScripts: Schema.optionalKey(Schema.Array(ProjectScript)),
  }),
);
export type WorkSettingsEditPatch = typeof WorkSettingsEditPatch.Type;

export const WorkSettingsEdit = strictJsonCodec(
  Schema.Struct({
    patch: Schema.optionalKey(WorkSettingsEditPatch),
    clear: Schema.optionalKey(Schema.Array(WorkSettingKey).check(Schema.isUnique())),
  }).check(
    Schema.makeFilter((edit) =>
      (edit.clear ?? []).every((key) => !Object.hasOwn(edit.patch ?? {}, key)),
    ),
  ),
);
export type WorkSettingsEdit = typeof WorkSettingsEdit.Type;

const decodeDeclaredWorkPatch = Schema.decodeUnknownResult(DeclaredWorkPatch);
const decodeWorkSettingsEdit = Schema.decodeUnknownResult(WorkSettingsEdit);
const encodeWorkSettingsEditPatch = Schema.encodeResult(WorkSettingsEditPatch);

export class WorkSettingsPolicyError extends Schema.TaggedError<WorkSettingsPolicyError>()(
  "WorkSettingsPolicyError",
  { reason: Schema.Literals(["invalid-stored-settings", "invalid-edit"]) },
) {
  override get message() {
    return this.reason === "invalid-edit"
      ? "Invalid work settings edit."
      : "Invalid stored work settings.";
  }
}

/** Internal storage representation. Never expose this record as a settings DTO. */
export type RawWorkSettings = Schema.JsonObject;

/** Decodes only the four declared local values, stripping all future fields from the DTO. */
export const readDeclaredWorkPatch = (raw: unknown) =>
  decodeDeclaredWorkPatch(raw).pipe(
    Result.mapError(() => new WorkSettingsPolicyError({ reason: "invalid-stored-settings" })),
  );

/** Catalog supplies an already validated root-to-target chain; no actor defaults participate. */
export const foldWorkSettings = (rootToTarget: ReadonlyArray<RawWorkSettings>) =>
  Result.gen(function* () {
    const effective: EffectiveWorkSettings = {
      defaultModelSelection: DEFAULT_SERVER_SETTINGS.defaultModelSelection,
      defaultRuntimeMode: DEFAULT_SERVER_SETTINGS.defaultRuntimeMode,
      defaultAutoPull: DEFAULT_SERVER_SETTINGS.defaultAutoPull,
      defaultProjectScripts: DEFAULT_SERVER_SETTINGS.defaultProjectScripts,
    };
    for (const contribution of rootToTarget) {
      const declared = yield* readDeclaredWorkPatch(contribution);
      Object.assign(effective, declared);
    }
    return effective;
  });

/** Only local raw values participate in recursive edits. Validation precedes any returned mutation. */
export const applyWorkSettingsEdit = (rawLocal: unknown, input: unknown) =>
  Result.gen(function* () {
    const edit = yield* decodeWorkSettingsEdit(input).pipe(
      Result.mapError(() => new WorkSettingsPolicyError({ reason: "invalid-edit" })),
    );
    if (!isStoredRecord(rawLocal)) {
      return yield* Result.fail(new WorkSettingsPolicyError({ reason: "invalid-stored-settings" }));
    }
    // Encode only new input; closed codecs must never round-trip the existing raw record.
    const patch = yield* encodeWorkSettingsEditPatch(edit.patch ?? {}).pipe(
      Result.mapError(() => new WorkSettingsPolicyError({ reason: "invalid-edit" })),
    );
    if (!isJsonRecord(patch)) {
      return yield* Result.fail(new WorkSettingsPolicyError({ reason: "invalid-edit" }));
    }
    const next = { ...rawLocal };
    for (const key of edit.clear ?? []) delete next[key];
    for (const key of keys) {
      const value = patch[key];
      if (Object.hasOwn(patch, key) && value !== undefined) {
        next[key] = mergeLocalJson(Object.hasOwn(rawLocal, key) ? rawLocal[key] : undefined, value);
      }
    }
    yield* readDeclaredWorkPatch(next).pipe(
      Result.mapError(
        () =>
          new WorkSettingsPolicyError({
            reason: Result.isFailure(readDeclaredWorkPatch(rawLocal))
              ? "invalid-stored-settings"
              : "invalid-edit",
          }),
      ),
    );
    const changed = !equalJson(rawLocal, next);
    return { rawLocal: changed ? next : rawLocal, changed };
  });
