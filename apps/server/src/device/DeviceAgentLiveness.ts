import { ProviderSessionId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";

export type DeviceAgentSessionLiveness = (
  providerSessionId: ProviderSessionId,
) => Effect.Effect<boolean | null>;

export class DeviceAgentLiveness extends Context.Service<
  DeviceAgentLiveness,
  {
    readonly bind: (query: DeviceAgentSessionLiveness) => Effect.Effect<void>;
    readonly isLive: DeviceAgentSessionLiveness;
  }
>()("t3/device/DeviceAgentLiveness") {}

export const layer = Layer.effect(
  DeviceAgentLiveness,
  Effect.gen(function* () {
    const queryRef = yield* Ref.make<DeviceAgentSessionLiveness | null>(null);
    return DeviceAgentLiveness.of({
      bind: (query) => Ref.update(queryRef, (current) => current ?? query),
      isLive: (providerSessionId) =>
        Ref.get(queryRef).pipe(
          Effect.flatMap((query) =>
            query === null
              ? Effect.succeed(null)
              : query(providerSessionId).pipe(Effect.catchCause(() => Effect.succeed(null))),
          ),
        ),
    });
  }),
);

export const bindProviderSessionManager = Effect.gen(function* () {
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const deviceAgentLiveness = yield* DeviceAgentLiveness;
  yield* deviceAgentLiveness.bind(providerSessions.isLive);
});

export const layerBindProviderSessionManager = Layer.effectDiscard(bindProviderSessionManager);
