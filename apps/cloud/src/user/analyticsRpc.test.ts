import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentId,
} from "@t3tools/contracts";
import { SIGNALBOX_ANALYTICS_WS_METHODS as methods } from "@t3tools/contracts/signalboxAnalytics";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import { makeMemoryCloud } from "../testing.ts";
import * as CloudRpc from "./rpc.ts";

const connect = (cloud: ReturnType<typeof makeMemoryCloud>, userId: string, writable = true) =>
  Effect.andThen(
    cloud.userDirectory
      .forUser(userId)
      .recordSignIn({ id: userId, email: `${userId}@example.test` }),
    RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
      Effect.provide(
        Layer.mergeAll(
          CloudRpc.layerHandlers({
            identity: { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" },
            userId,
            sid: "analytics-test",
            via: "client",
          }),
          CloudRpc.layerScopeAuthorization(
            writable
              ? [AuthOrchestrationReadScope, AuthSettingsWriteScope]
              : [AuthOrchestrationReadScope],
          ),
        ).pipe(Layer.provide(cloud.layerFor(userId))),
      ),
    ),
  );

describe("cloud analytics preference RPC", () => {
  it.effect("persists the person's opt-in across clients and keeps other people separate", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      const writer = yield* connect(cloud, "alice");
      expect(yield* writer[methods.getSettings]({})).toEqual({
        enabled: false,
        disabledByServer: false,
      });
      expect(yield* writer[methods.setEnabled]({ enabled: true })).toEqual({
        enabled: true,
        disabledByServer: false,
      });
      const secondClient = yield* connect(cloud, "alice");
      expect(yield* secondClient[methods.getSettings]({})).toEqual({
        enabled: true,
        disabledByServer: false,
      });
      const otherPerson = yield* connect(cloud, "bob");
      expect(yield* otherPerson[methods.getSettings]({})).toEqual({
        enabled: false,
        disabledByServer: false,
      });
      yield* secondClient[methods.setEnabled]({ enabled: false });
      expect(yield* writer[methods.getSettings]({})).toEqual({
        enabled: false,
        disabledByServer: false,
      });
    }).pipe(Effect.scoped),
  );

  it.effect(
    "requires settings-write permission and leaves the preference untouched on refusal",
    () =>
      Effect.gen(function* () {
        const rpc = yield* connect(makeMemoryCloud(), "alice", false);
        const denied = yield* rpc[methods.setEnabled]({ enabled: true }).pipe(Effect.flip);
        expect(denied).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredScope: AuthSettingsWriteScope,
        });
        expect(yield* rpc[methods.getSettings]({})).toEqual({
          enabled: false,
          disabledByServer: false,
        });
      }).pipe(Effect.scoped),
  );

  it.effect("accepts bounded client events without requiring a telemetry sender", () =>
    Effect.gen(function* () {
      const rpc = yield* connect(makeMemoryCloud(), "alice");
      yield* rpc[methods.setEnabled]({ enabled: true });
      yield* rpc[methods.recordClientEvent]({ event: "capture.used" });
      yield* rpc[methods.recordClientEvent]({
        event: "feedback.sent",
        screenshotAttached: true,
        serverLogsAttached: false,
      });
      expect(yield* rpc[methods.getSettings]({})).toEqual({
        enabled: true,
        disabledByServer: false,
      });
    }).pipe(Effect.scoped),
  );
});
