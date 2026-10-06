import {
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import * as Environment from "../environment.ts";
import { layerMemoryStore } from "../testing.ts";
import * as CloudRpc from "./rpc.ts";

const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };

const client = (scopes: ReadonlyArray<AuthEnvironmentScope> = [AuthOrchestrationReadScope]) =>
  RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
    Effect.provide(
      Layer.mergeAll(
        CloudRpc.layerHandlers({
          identity,
          shellSnapshot: Effect.succeed(Environment.emptyShellSnapshot),
        }),
        CloudRpc.layerScopeAuthorization(scopes),
      ).pipe(Layer.provideMerge(layerMemoryStore)),
    ),
  );

describe("cloud RPC", () => {
  it.effect("opens the config stream with a snapshot of this environment and holds it open", () =>
    Effect.gen(function* () {
      const rpc = yield* client();
      const [first] = yield* rpc[WS_METHODS.subscribeServerConfig]({}).pipe(
        Stream.take(1),
        Stream.runCollect,
      );
      expect(first?.type).toBe("snapshot");
      if (first?.type !== "snapshot") return;
      expect(first.config.environment.environmentId).toBe("cloud-test");
      expect(first.config.environment.orchestrationProtocolVersion).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("sends the shell snapshot unless the client is already current", () =>
    Effect.gen(function* () {
      const rpc = yield* client();
      const shell = (input: { afterSequence?: number; requestCompletionMarker?: boolean }) =>
        rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell](input).pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.map(([item]) => item?.kind),
        );
      expect(yield* shell({})).toBe("snapshot");
      expect(yield* shell({ afterSequence: 0, requestCompletionMarker: true })).toBe(
        "synchronized",
      );
      // Ahead of the object (a reset one): start over from the snapshot.
      expect(yield* shell({ afterSequence: 7 })).toBe("snapshot");
    }).pipe(Effect.scoped),
  );

  it.effect("welcomes the primary client with nothing to bootstrap", () =>
    Effect.gen(function* () {
      const rpc = yield* client();
      const events = yield* rpc[WS_METHODS.subscribeServerLifecycle]({}).pipe(
        Stream.take(2),
        Stream.runCollect,
      );
      expect(events.map((event) => event.type)).toEqual(["welcome", "ready"]);
    }).pipe(Effect.scoped),
  );

  it.effect("authorizes every RPC against the connection's scopes", () =>
    Effect.gen(function* () {
      const rpc = yield* client([]);
      const denied = yield* rpc[WS_METHODS.serverProbe]({}).pipe(Effect.flip);
      expect(denied).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredScope: AuthOrchestrationReadScope,
      });
    }).pipe(Effect.scoped),
  );
});
