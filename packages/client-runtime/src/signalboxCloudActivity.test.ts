import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "./connection/model.ts";
import * as EnvironmentSupervisor from "./connection/supervisor.ts";
import type { WsRpcProtocolClient } from "./rpc/protocol.ts";
import type { RpcSession } from "./rpc/session.ts";
import { unlessSignalboxCloud } from "./signalboxCloudActivity.ts";

/** Runs `effect` against a connected environment advertising `capabilities`. */
const connectedTo = <A, E>(
  capabilities: ServerConfig["environment"]["capabilities"],
  effect: Effect.Effect<A, E, EnvironmentSupervisor.EnvironmentSupervisor>,
) =>
  Effect.gen(function* () {
    const session: RpcSession = {
      client: {} as WsRpcProtocolClient,
      initialConfig: Effect.succeed({ environment: { capabilities } } as ServerConfig),
      subscribeServerConfig: () => {
        throw new Error("not subscribed in these tests");
      },
      ready: Effect.void,
      probe: Effect.void,
      closed: Effect.never,
    };
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target: new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make("environment"),
        label: "Environment",
        httpBaseUrl: "https://environment.example.test",
        wsBaseUrl: "wss://environment.example.test",
      }),
      state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
      session: yield* SubscriptionRef.make(Option.some(session)),
      prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
    return yield* Effect.provideService(
      effect,
      EnvironmentSupervisor.EnvironmentSupervisor,
      supervisor,
    );
  });

describe("unlessSignalboxCloud", () => {
  it.effect("reports to a self-hosted environment but not to Signalbox Cloud", () =>
    Effect.gen(function* () {
      let reports = 0;
      const report = unlessSignalboxCloud(Effect.sync(() => reports++));

      yield* connectedTo({ repositoryIdentity: true }, report);
      expect(reports).toBe(1);
      yield* connectedTo({ repositoryIdentity: false, signalboxCloud: true }, report);
      expect(reports).toBe(1);
    }),
  );
});
