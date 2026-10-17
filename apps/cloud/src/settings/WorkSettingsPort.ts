import { NonNegativeInt } from "@t3tools/contracts";
import type { Commit, SyncCursor, ViewFrame } from "@signalbox/sync/definition";
import type * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

import {
  DeclaredWorkPatch,
  EffectiveWorkSettings,
  WorkSettingsEdit,
  WorkSettingsEditPatch,
  WorkSettingKey,
} from "./WorkSettings.ts";
import { strictJsonCodec } from "./internal/workSettingsJson.ts";

// Catalog has not exported these selectors yet. Neither token encodes a caller-owned chain.
export const SettingsTarget = Schema.Trimmed.check(Schema.isMinLength(1)).pipe(
  Schema.brand("CatalogSettingsTarget"),
);
export type SettingsTarget = typeof SettingsTarget.Type;

export const SettingsResolution = Schema.Trimmed.check(Schema.isMinLength(1)).pipe(
  Schema.brand("CatalogSettingsResolution"),
);
export type SettingsResolution = typeof SettingsResolution.Type;

export const SettingsLocalRevision = NonNegativeInt.check(
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);

export const SettingsSnapshot = Schema.Struct({
  local: Schema.Struct({ revision: SettingsLocalRevision, patch: DeclaredWorkPatch }),
  effective: EffectiveWorkSettings,
  canWrite: Schema.Boolean,
  resolution: SettingsResolution,
});
export type SettingsSnapshot = typeof SettingsSnapshot.Type;

export const SettingsState = Schema.Union([
  Schema.TaggedStruct("Ready", { snapshot: SettingsSnapshot }),
  Schema.TaggedStruct("LocalRepairRequired", {
    localRevision: SettingsLocalRevision,
    resolution: SettingsResolution,
    canWrite: Schema.Boolean,
  }),
  Schema.TaggedStruct("InheritedUnavailable", {}),
]);
export type SettingsState = typeof SettingsState.Type;

export const SettingsView = strictJsonCodec(
  Schema.Struct({
    type: Schema.Literal("settings"),
    target: SettingsTarget,
  }),
);
export type SettingsView = typeof SettingsView.Type;

const decodeEdit = Schema.decodeUnknownResult(WorkSettingsEdit);
export const SettingsChange = strictJsonCodec(
  Schema.Struct({
    type: Schema.Literal("settings.patch"),
    target: SettingsTarget,
    expectedLocalRevision: SettingsLocalRevision,
    // A local revision cannot detect an ancestor edit, move, or access-policy change.
    expectedResolution: SettingsResolution,
    patch: WorkSettingsEditPatch,
    clear: Schema.Array(WorkSettingKey),
  }).check(
    Schema.makeFilter((command) =>
      Result.isSuccess(
        decodeEdit({
          patch: command.patch,
          clear: command.clear,
        }),
      ),
    ),
  ),
);
export type SettingsChange = typeof SettingsChange.Type;

export const SettingsChangeResult = Schema.Struct({
  localRevision: SettingsLocalRevision,
  changed: Schema.Boolean,
});
export type SettingsChangeResult = typeof SettingsChangeResult.Type;

export class SettingsPortError extends Schema.TaggedError<SettingsPortError>()(
  "SettingsPortError",
  {
    reason: Schema.Literals([
      "denied",
      "invalid-input",
      "revision-conflict",
      "resolution-conflict",
      "unavailable",
    ]),
  },
) {}

/** Actor comes from server authentication; it is never decoded from a settings request. */
export interface WorkSettingsPort<Actor> {
  /**
   * Catalog resolves and authorizes the current target and chain before classifying it.
   * Unavailable states remain subscribed to ancestor repairs, topology and access changes.
   * Revoked clears every state; recovery emits a fresh state rather than a partial fold.
   */
  readonly view: (
    actor: Actor,
    query: SettingsView,
    resume?: SyncCursor,
  ) => Stream.Stream<ViewFrame<SettingsState>, SettingsPortError>;
  readonly change: (
    actor: Actor,
    command: SettingsChange,
    operationKey: string,
  ) => Effect.Effect<Commit<SettingsChangeResult>, SettingsPortError>;
}
