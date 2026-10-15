import type { EnvironmentId, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as UserStore from "../user/UserStore.ts";
import * as PushDevices from "./PushDevices.ts";
import { pushFor, wants } from "./pushRules.ts";
import * as PushSender from "./PushSender.ts";

/**
 * Pushes a person's thread changes to their phones. The user's object calls it
 * with each thread summary it indexes, so pushes come from the cloud whether
 * or not any client is open. A push that can't be sent is logged and dropped:
 * the summary is indexed either way, and a retried delivery is the same
 * revision, which never pushes twice.
 */
export class PushNotifier extends Context.Service<
  PushNotifier,
  {
    readonly threadChanged: (input: {
      readonly previous: OrchestrationV2ThreadShell | null;
      readonly next: OrchestrationV2ThreadShell;
    }) => Effect.Effect<void>;
  }
>()("@signalbox/cloud/push/PushNotifier") {}

/** `environmentId` is the user object's own, which deep links name. */
const make = (environmentId: EnvironmentId) =>
  Effect.gen(function* () {
    const devices = yield* PushDevices.PushDevices;
    const sender = yield* PushSender.PushSender;
    const store = yield* UserStore.UserStore;

    const threadChanged: PushNotifier["Service"]["threadChanged"] = Effect.fn(
      "PushNotifier.threadChanged",
    )(
      function* ({ previous, next }) {
        const message = pushFor({
          environmentId,
          previous,
          next,
          now: yield* Clock.currentTimeMillis,
        });
        if (message === null) return;
        yield* Effect.annotateCurrentSpan({ "push.phase": message.phase, "thread.id": next.id });
        const targets = (yield* devices.list).filter((device) =>
          wants(device.preferences, message.phase),
        );
        yield* Effect.forEach(
          targets,
          (device) =>
            Effect.gen(function* () {
              // Signed out or revoked: the phone no longer speaks for this person.
              if ((yield* store.findSession(device.sid)) === null) {
                yield* devices.remove(device.deviceId);
                return "signed-out";
              }
              const outcome = yield* sender.send(device, message);
              if (outcome._tag === "gone") yield* devices.remove(device.deviceId);
              if (outcome._tag !== "delivered") {
                yield* Effect.logInfo("push not delivered", {
                  platform: device.platform,
                  outcome: outcome._tag,
                  reason: outcome.reason,
                });
              }
              return outcome._tag;
            }).pipe(
              Effect.catch((cause) =>
                Effect.as(
                  Effect.logWarning("push failed", { platform: device.platform, cause }),
                  "failed",
                ),
              ),
            ),
          { concurrency: 4 },
        ).pipe(
          Effect.tap((outcomes) =>
            Effect.annotateCurrentSpan({
              "push.devices": targets.length,
              "push.delivered": outcomes.filter((outcome) => outcome === "delivered").length,
            }),
          ),
        );
      },
      // Any trouble loses this push, never the summary.
      Effect.catchCause((cause) => Effect.logWarning("push skipped", { cause })),
    );

    return PushNotifier.of({ threadChanged });
  });

/**
 * Pushes with everything they need in a user's object: the phones, the
 * senders and the environment id. Needs an `HttpClient`, the Worker's config
 * and the user's storage.
 */
export const layerWithDevices = (environmentId: EnvironmentId) =>
  Layer.effect(PushNotifier, make(environmentId)).pipe(
    Layer.provideMerge(Layer.mergeAll(PushDevices.layer, PushSender.layer)),
  );
