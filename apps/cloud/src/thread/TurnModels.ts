import type { ModelSelection, ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as PoolDirectory from "../pool/PoolDirectory.ts";
import type { PoolRejectedError } from "../pool/PoolEngine.ts";
import { poolKindOfInstance, servesModel } from "../models/ModelRouting.ts";
import { SCRIPTED_INSTANCE_ID } from "./scriptedProvider.ts";

/**
 * Whether a turn may start on the model it names. A harness turn runs on the
 * pool its thread's chain resolves to (`turnPool.ts`), never one the
 * selection names, and that pool must serve the model now: the picker offers
 * what the pool serves, and a selection it no longer serves (an account
 * removed, a model retired) is refused with a reason rather than sent to fail
 * upstream. With no pool on the chain, nothing runs. The scripted provider
 * runs only where it is on; nothing else runs at all.
 */

export class ModelNotServedError extends Schema.TaggedError<ModelNotServedError>()(
  "ModelNotServedError",
  { instanceId: Schema.String, model: Schema.String },
) {
  override get message() {
    return `This pool doesn't serve ${this.model} right now. Pick another model.`;
  }
}

export class PoolNeededError extends Schema.TaggedError<PoolNeededError>()("PoolNeededError", {}) {
  override get message() {
    return "This folder needs a pool. Choose one for it or a folder above it.";
  }
}

export class ProviderUnavailableError extends Schema.TaggedError<ProviderUnavailableError>()(
  "ProviderUnavailableError",
  { instanceId: Schema.String },
) {
  override get message() {
    return "That harness isn't available in Signalbox Cloud. Choose Claude or Codex from a pool.";
  }
}

export class ProviderModeUnavailableError extends Schema.TaggedError<ProviderModeUnavailableError>()(
  "ProviderModeUnavailableError",
  {
    instanceId: Schema.String,
    modeKind: Schema.Literals(["runtime", "interaction"]),
    mode: Schema.String,
  },
) {
  override get message() {
    return `That harness doesn't support the ${this.modeKind} mode '${this.mode}'.`;
  }
}

// ClaudeAdapterV2 and CodexAdapterV2 handle each current contract mode. Keep
// the sets explicit so a new contract mode is refused until cloud supports it.
const SUPPORTED_RUNTIME_MODES = new Set<RuntimeMode>([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);
const SUPPORTED_INTERACTION_MODES = new Set<ProviderInteractionMode>(["default", "plan"]);

export class TurnModels extends Context.Service<
  TurnModels,
  {
    /** Succeeds when a turn of `ownerId`'s may start on `selection` on their `pool` (null: none). */
    readonly check: (input: {
      readonly ownerId: string;
      readonly pool: string | null;
      readonly selection: ModelSelection;
      readonly runtimeMode?: RuntimeMode;
      readonly interactionMode?: ProviderInteractionMode;
    }) => Effect.Effect<
      void,
      | ModelNotServedError
      | PoolNeededError
      | ProviderUnavailableError
      | ProviderModeUnavailableError
      | PoolRejectedError
      | PoolDirectory.PoolObjectError
    >;
  }
>()("@signalbox/cloud/thread/TurnModels") {}

/** `scripted`: whether the scripted provider runs here (`SCRIPTED_PROVIDER`). */
export const layer = (options: { readonly scripted: boolean }) =>
  Layer.effect(
    TurnModels,
    Effect.gen(function* () {
      const directory = yield* PoolDirectory.PoolDirectory;
      return TurnModels.of({
        check: ({ ownerId, pool, selection, runtimeMode, interactionMode }) =>
          Effect.gen(function* () {
            const kind = poolKindOfInstance(selection.instanceId);
            if (kind === undefined) {
              if (options.scripted && selection.instanceId === SCRIPTED_INSTANCE_ID) return;
              return yield* new ProviderUnavailableError({ instanceId: selection.instanceId });
            }
            if (runtimeMode !== undefined && !SUPPORTED_RUNTIME_MODES.has(runtimeMode)) {
              return yield* new ProviderModeUnavailableError({
                instanceId: selection.instanceId,
                modeKind: "runtime",
                mode: runtimeMode,
              });
            }
            if (
              interactionMode !== undefined &&
              !SUPPORTED_INTERACTION_MODES.has(interactionMode)
            ) {
              return yield* new ProviderModeUnavailableError({
                instanceId: selection.instanceId,
                modeKind: "interaction",
                mode: interactionMode,
              });
            }
            if (pool === null) return yield* new PoolNeededError();
            const { models } = yield* directory
              .forPool(PoolDirectory.poolObjectName(ownerId, pool))
              .models({ userId: ownerId });
            if (!servesModel(kind, models, selection.model)) {
              return yield* new ModelNotServedError({
                instanceId: selection.instanceId,
                model: selection.model,
              });
            }
          }),
      });
    }),
  );

/** Every model may start; for tests that aren't about models. */
export const layerUnchecked = Layer.succeed(
  TurnModels,
  TurnModels.of({ check: () => Effect.void }),
);
