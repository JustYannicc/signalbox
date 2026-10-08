import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  AuthProvidersManageScope,
  EnvironmentId,
  ProviderInstanceId,
  WS_METHODS,
} from "@t3tools/contracts";
import { poolInstanceId, poolSourceId } from "@t3tools/contracts/accountHub";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import { makeMemoryCloud } from "../testing.ts";
import * as CloudRpc from "./rpc.ts";

const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };
const userId = "user_1";

const client = (
  scopes: ReadonlyArray<AuthEnvironmentScope> = [
    AuthOrchestrationReadScope,
    AuthOrchestrationOperateScope,
    AuthProvidersManageScope,
  ],
) =>
  Effect.gen(function* () {
    const cloud = makeMemoryCloud();
    yield* cloud.userDirectory.forUser(userId).recordSignIn({ id: userId, email: "a@b.c" });
    const rpc = yield* RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
      Effect.provide(
        Layer.mergeAll(
          CloudRpc.layerHandlers({ identity, userId }),
          CloudRpc.layerScopeAuthorization(scopes),
        ).pipe(Layer.provide(cloud.layerFor(userId))),
      ),
    );
    return { cloud, rpc };
  });

type Rpc = Effect.Success<ReturnType<typeof client>>["rpc"];

const first = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
  stream.pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.map(([item]) => item!),
  );

const pools = (rpc: Rpc) => first(rpc[WS_METHODS.accountPoolSubscribe]({}));

/** The config snapshot and the usage sources that follow it. */
const config = (rpc: Rpc) =>
  rpc[WS_METHODS.subscribeServerConfig]({ usageLimitSources: true }).pipe(
    Stream.take(2),
    Stream.runCollect,
    Effect.map(([snapshot, sources]) => {
      if (snapshot?.type !== "snapshot" || sources?.type !== "usageLimitSourcesUpdated") {
        throw new Error("Expected a snapshot, then usage sources");
      }
      return { config: snapshot.config, sources: sources.payload.sources };
    }),
  );

describe("cloud pool RPC", () => {
  it.live("creates a pool and signs an account into it from the existing pool UI", () =>
    Effect.gen(function* () {
      const { rpc } = yield* client();

      // Settings → Pools: everyone starts with Personal; New pool adds one.
      expect((yield* pools(rpc)).map((pool) => pool.name)).toEqual(["Personal"]);
      const work = yield* rpc[WS_METHODS.accountPoolCreate]({ name: "Work" });
      expect(work).toMatchObject({ name: "Work", personal: false, backing: { mode: "managed" } });
      expect((yield* pools(rpc)).map((pool) => pool.name)).toEqual(["Personal", "Work"]);

      // The pool's instances are in the config, grouped under it, signed out for now.
      const instanceId = ProviderInstanceId.make(poolInstanceId("claude", work.id));
      const before = yield* config(rpc);
      expect(before.config.settings.providerInstances[instanceId]).toMatchObject({
        driver: "claudeAgent",
        displayName: "Claude · Work",
        config: { setupMode: "hub", poolId: work.id },
      });
      const provider = before.config.providers.find((entry) => entry.instanceId === instanceId);
      expect(provider?.auth.status).toBe("unauthenticated");
      expect(before.sources.map((source) => source.id)).toEqual([
        poolSourceId("personal"),
        poolSourceId(work.id),
      ]);

      // Add account → Claude: the pool's CLIProxyAPI runs the login.
      expect((yield* first(rpc[WS_METHODS.providerAuthSubscribe]({ instanceId }))).phase).toBe(
        "idle",
      );
      const started = yield* rpc[WS_METHODS.providerAuthStart]({
        instanceId,
        callbackMode: "client",
      });
      expect(started.phase).toBe("waiting");
      expect(started.interaction).toMatchObject({ type: "browser", acceptsCallback: true });
      const loginState = new URL(started.authorizationUrl!).searchParams.get("state");
      yield* rpc[WS_METHODS.providerAuthComplete]({
        instanceId,
        flowId: started.flowId!,
        callbackUrl: `http://localhost:54545/callback?code=c&state=${loginState}`,
      });
      const finished = yield* rpc[WS_METHODS.providerAuthSubscribe]({ instanceId }).pipe(
        Stream.filter((state) => state.phase === "succeeded" || state.phase === "failed"),
        (stream) => first(stream),
      );
      expect(finished.phase).toBe("succeeded");

      // Limits lists the account under its pool; the picker can run on it.
      const after = yield* config(rpc);
      const source = after.sources.find((entry) => entry.id === poolSourceId(work.id));
      expect(source?.label).toBe("Work");
      expect(source?.accounts).toEqual([
        expect.objectContaining({ driver: "claudeAgent", email: expect.stringMatching(/@/u) }),
      ]);
      expect(
        after.config.providers.find((entry) => entry.instanceId === instanceId)?.auth.status,
      ).toBe("authenticated");
      const [, workView] = yield* first(rpc[WS_METHODS.accountPoolSubscribeViews]({}));
      expect(workView?.providers.find((entry) => entry.driver === "claudeAgent")).toMatchObject({
        providerInstanceId: instanceId,
        available: true,
        usage: [],
      });
    }).pipe(Effect.scoped),
  );

  it.effect("renames and deletes pools, and keeps Personal", () =>
    Effect.gen(function* () {
      const { rpc, cloud } = yield* client();
      const work = yield* rpc[WS_METHODS.accountPoolCreate]({ name: "Work" });
      expect(
        (yield* rpc[WS_METHODS.accountPoolRename]({ poolId: work.id, name: "Team" })).name,
      ).toBe("Team");
      expect((yield* pools(rpc)).map((pool) => pool.name)).toEqual(["Personal", "Team"]);

      const personal = yield* Effect.flip(
        rpc[WS_METHODS.accountPoolDelete]({ poolId: "personal" }),
      );
      expect(personal.message).toBe("Your personal pool can't be deleted.");
      yield* rpc[WS_METHODS.accountPoolDelete]({ poolId: work.id });
      expect((yield* pools(rpc)).map((pool) => pool.name)).toEqual(["Personal"]);
      expect(cloud.pools.objects.get(`${userId}:${work.id}`)?.erased()).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("says plainly what cloud pools can't do yet", () =>
    Effect.gen(function* () {
      const { rpc } = yield* client();
      const error = yield* Effect.flip(
        rpc[WS_METHODS.accountPoolAddApiKey]({
          poolId: "personal",
          provider: "anthropic",
          apiKey: "sk-test",
        }),
      );
      expect(error.message).toBe("Signalbox Cloud pools can't take API keys yet.");
    }).pipe(Effect.scoped),
  );

  it.effect("needs providers:manage to manage pools", () =>
    Effect.gen(function* () {
      const { rpc } = yield* client([AuthOrchestrationReadScope]);
      const error = yield* Effect.flip(rpc[WS_METHODS.accountPoolCreate]({ name: "Work" }));
      expect(error._tag).toBe("EnvironmentAuthorizationError");
      // The member-safe overviews only need read access.
      expect(
        (yield* first(rpc[WS_METHODS.accountPoolSubscribeViews]({}))).map((v) => v.name),
      ).toEqual(["Personal"]);
    }).pipe(Effect.scoped),
  );
});
