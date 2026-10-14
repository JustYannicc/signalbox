import type { ModelSelection } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as PoolDirectory from "../pool/PoolDirectory.ts";
import type { PoolRejectedError } from "../pool/PoolEngine.ts";
import { poolKindOfInstance, servesModel } from "./providerCatalog.ts";
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
    return "That provider isn't available in Signalbox Cloud. Pick a model from one of your pools.";
  }
}

export class TurnModels extends Context.Service<
  TurnModels,
  {
    /** Succeeds when a turn of `ownerId`'s may start on `selection` on their `pool` (null: none). */
    readonly check: (input: {
      readonly ownerId: string;
      readonly pool: string | null;
      readonly selection: ModelSelection;
    }) => Effect.Effect<
      void,
      | ModelNotServedError
      | PoolNeededError
      | ProviderUnavailableError
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
        check: ({ ownerId, pool, selection }) =>
          Effect.gen(function* () {
            const kind = poolKindOfInstance(selection.instanceId);
            if (kind === undefined) {
              if (options.scripted && selection.instanceId === SCRIPTED_INSTANCE_ID) return;
              return yield* new ProviderUnavailableError({ instanceId: selection.instanceId });
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
