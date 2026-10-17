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
import * as Clock from "effect/Clock";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
          CloudRpc.layerHandlers({ identity, userId, sid: "test-session" }),
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

/**
 * Personal's object is down for the first read of the pools, as on a cold
 * start. Completes the returned Deferred when that read has failed.
 */
const personalDownOnce = (cloud: Effect.Success<ReturnType<typeof client>>["cloud"]) =>
  Effect.gen(function* () {
    const name = `${userId}:personal`;
    const personal = cloud.pools.objectFor(name);
    const failed = yield* Deferred.make<void>();
    cloud.pools.objects.set(name, {
      ...personal,
      api: {
        ...personal.api,
        create: (...args) => {
          if (Deferred.doneUnsafe(failed, Effect.void)) {
            return Promise.reject(new Error("Pool object unavailable"));
          }
          return personal.api.create(...args);
        },
      },
    });
    return failed;
  });

describe("cloud pool RPC", () => {
  it.live("refuses another flow's callback and lets the active sign-in be corrected", () =>
    Effect.gen(function* () {
      const { rpc } = yield* client();
      const instanceId = ProviderInstanceId.make(poolInstanceId("claude", "personal"));
      const otherId = ProviderInstanceId.make(poolInstanceId("codex", "personal"));
      const started = yield* rpc[WS_METHODS.providerAuthStart]({
        instanceId,
        callbackMode: "client",
      });
      const other = yield* rpc[WS_METHODS.providerAuthStart]({ instanceId: otherId });
      const otherState = "foreign-state";
      const failure = yield* Effect.flip(
        rpc[WS_METHODS.providerAuthComplete]({
          instanceId,
          flowId: started.flowId!,
          callbackUrl: `http://localhost:54545/callback?code=foreign-code&state=${otherState}`,
        }),
      );
      expect(failure.message).toBe(
        "Enter the authorization code or the full callback URL from this sign-in.",
      );
      expect((yield* first(rpc[WS_METHODS.providerAuthSubscribe]({ instanceId }))).phase).toBe(
        "waiting",
      );
      yield* rpc[WS_METHODS.providerAuthCancel]({ instanceId: otherId, flowId: other.flowId! });
      yield* rpc[WS_METHODS.providerAuthComplete]({
        instanceId,
        flowId: started.flowId!,
        callbackUrl: "correct-code",
      });
      const finished = yield* first(
        rpc[WS_METHODS.providerAuthSubscribe]({ instanceId }).pipe(
          Stream.filter((state) => state.phase === "succeeded" || state.phase === "failed"),
        ),
      );
      expect(finished.phase).toBe("succeeded");
    }).pipe(Effect.scoped),
  );

  it.live.each([{ provider: "claude", driver: "claudeAgent" }] as const)(
    "adds a $provider account from its short authorization code",
    ({ provider, driver }) =>
      Effect.gen(function* () {
        const { rpc } = yield* client();
        const work = yield* rpc[WS_METHODS.accountPoolCreate]({ name: "Work" });
        const instanceId = ProviderInstanceId.make(poolInstanceId(provider, work.id));
        const started = yield* rpc[WS_METHODS.providerAuthStart]({ instanceId });
        yield* rpc[WS_METHODS.providerAuthComplete]({
          instanceId,
          flowId: started.flowId!,
          callbackUrl: "short-authorization-code",
        });
        const finished = yield* first(
          rpc[WS_METHODS.providerAuthSubscribe]({ instanceId }).pipe(
            Stream.filter((state) => state.phase === "succeeded" || state.phase === "failed"),
          ),
        );
        expect(finished.phase).toBe("succeeded");
        expect(started.interaction).toMatchObject({
          type: "browser",
          requiresConsent: false,
          acceptsCallback: false,
          acceptsCode: true,
        });
        expect(new URL(started.authorizationUrl!).searchParams.get("redirect_uri")).toBe(
          "https://platform.claude.com/oauth/code/callback",
        );
        expect(
          (yield* config(rpc)).sources.find((source) => source.id === poolSourceId(work.id))
            ?.accounts,
        ).toEqual([expect.objectContaining({ driver })]);
      }).pipe(Effect.scoped),
  );

  it.live("keeps manual Claude codes bound to the active authorization state", () =>
    Effect.gen(function* () {
      const { rpc } = yield* client();
      const instanceId = ProviderInstanceId.make(poolInstanceId("claude", "personal"));
      const started = yield* rpc[WS_METHODS.providerAuthStart]({ instanceId });
      const state = new URL(started.authorizationUrl!).searchParams.get("state");
      expect(started.interaction).toMatchObject({
        type: "browser",
        requiresConsent: false,
        acceptsCallback: false,
        acceptsCode: true,
      });
      const failure = yield* Effect.flip(
        rpc[WS_METHODS.providerAuthComplete]({
          instanceId,
          flowId: started.flowId!,
          callbackUrl: "foreign-code#foreign-state",
        }),
      );
      expect(failure.message).toBe("Enter the authorization code from this sign-in.");
      expect((yield* first(rpc[WS_METHODS.providerAuthSubscribe]({ instanceId }))).phase).toBe(
        "waiting",
      );
      yield* rpc[WS_METHODS.providerAuthComplete]({
        instanceId,
        flowId: started.flowId!,
        callbackUrl: `correct-code#${state}`,
      });
      const finished = yield* first(
        rpc[WS_METHODS.providerAuthSubscribe]({ instanceId }).pipe(
          Stream.filter((value) => value.phase === "succeeded" || value.phase === "failed"),
        ),
      );
      expect(finished.phase).toBe("succeeded");
    }).pipe(Effect.scoped),
  );

  it.live("finishes Codex device sign-in without submitting a callback", () =>
    Effect.gen(function* () {
      const { rpc, cloud } = yield* client();
      const instanceId = ProviderInstanceId.make(poolInstanceId("codex", "personal"));
      const before = yield* Clock.currentTimeMillis;
      const started = yield* rpc[WS_METHODS.providerAuthStart]({
        instanceId,
        callbackMode: "client",
      });
      expect(started.phase).toBe("waiting");
      expect(started.authorizationUrl).toBe("https://auth.openai.com/codex/device");
      expect(started.interaction).toMatchObject({
        type: "deviceCode",
        url: started.authorizationUrl,
      });
      expect(Date.parse(started.expiresAt!)).toBeGreaterThanOrEqual(before + 900_000);
      expect(Date.parse(started.expiresAt!)).toBeLessThanOrEqual(
        (yield* Clock.currentTimeMillis) + 900_000,
      );
      if (started.interaction?.type !== "deviceCode") throw new Error("Expected a device code");
      const failure = yield* Effect.flip(
        rpc[WS_METHODS.providerAuthComplete]({
          instanceId,
          flowId: started.flowId!,
          callbackUrl: "unnecessary-code",
        }),
      );
      expect(failure.message).toContain("finish automatically");
      expect(
        cloud.pools
          .objectFor(`${userId}:personal`)
          .cliProxyApi.authorizeDevice(started.interaction.userCode),
      ).toBe(true);
      const finished = yield* first(
        rpc[WS_METHODS.providerAuthSubscribe]({ instanceId }).pipe(
          Stream.filter((state) => state.phase === "succeeded" || state.phase === "failed"),
        ),
      );
      expect(finished.phase).toBe("succeeded");
      expect(finished.interaction).toBeNull();
      expect(
        (yield* config(rpc)).sources.find((source) => source.id === poolSourceId("personal"))
          ?.accounts,
      ).toEqual([expect.objectContaining({ driver: "codex" })]);
    }).pipe(Effect.scoped),
  );

  it.live("cancels and replaces device sessions without leaving the old code usable", () =>
    Effect.gen(function* () {
      const { rpc, cloud } = yield* client();
      const instanceId = ProviderInstanceId.make(poolInstanceId("codex", "personal"));
      const firstLogin = yield* rpc[WS_METHODS.providerAuthStart]({ instanceId });
      const secondLogin = yield* rpc[WS_METHODS.providerAuthStart]({ instanceId });
      const fake = cloud.pools.objectFor(`${userId}:personal`).cliProxyApi;
      if (
        firstLogin.interaction?.type !== "deviceCode" ||
        secondLogin.interaction?.type !== "deviceCode"
      ) {
        throw new Error("Expected device codes");
      }
      expect(fake.authorizeDevice(firstLogin.interaction.userCode)).toBe(false);
      const cancelled = yield* rpc[WS_METHODS.providerAuthCancel]({
        instanceId,
        flowId: secondLogin.flowId!,
      });
      expect(cancelled.phase).toBe("cancelled");
      expect(cancelled.interaction).toBeNull();
      expect(fake.authorizeDevice(secondLogin.interaction.userCode)).toBe(false);
      expect((yield* first(rpc[WS_METHODS.providerAuthSubscribe]({ instanceId }))).phase).toBe(
        "cancelled",
      );
    }).pipe(Effect.scoped),
  );

  it.live("keeps a device login alive when CLIProxyAPI has started saving it", () =>
    Effect.gen(function* () {
      const { rpc, cloud } = yield* client();
      const instanceId = ProviderInstanceId.make(poolInstanceId("codex", "personal"));
      const started = yield* rpc[WS_METHODS.providerAuthStart]({ instanceId });
      if (started.interaction?.type !== "deviceCode") throw new Error("Expected a device code");
      const fake = cloud.pools.objectFor(`${userId}:personal`).cliProxyApi;
      expect(fake.beginLoginSave(started.interaction.userCode)).toBe(true);

      const cancel = yield* rpc[WS_METHODS.providerAuthCancel]({
        instanceId,
        flowId: started.flowId!,
      });
      expect(cancel.phase).toBe("verifying");
      expect(cancel.interaction).toBeNull();
      expect((yield* rpc[WS_METHODS.providerAuthStart]({ instanceId })).phase).toBe("verifying");

      expect(fake.authorizeDevice(started.interaction.userCode)).toBe(true);
      const finished = yield* first(
        rpc[WS_METHODS.providerAuthSubscribe]({ instanceId }).pipe(
          Stream.filter((state) => state.phase === "succeeded" || state.phase === "failed"),
        ),
      );
      expect(finished.phase).toBe("succeeded");
      expect(
        (yield* config(rpc)).sources.find((source) => source.id === poolSourceId("personal"))
          ?.accounts,
      ).toEqual([expect.objectContaining({ driver: "codex" })]);
    }).pipe(Effect.scoped),
  );

  it.effect("expires device sign-in at the provider deadline and cancels its session", () =>
    Effect.gen(function* () {
      const { rpc, cloud } = yield* client();
      const instanceId = ProviderInstanceId.make(poolInstanceId("codex", "personal"));
      const started = yield* rpc[WS_METHODS.providerAuthStart]({ instanceId });
      if (started.interaction?.type !== "deviceCode") throw new Error("Expected a device code");
      yield* TestClock.adjust("15 minutes");
      const finished = yield* first(
        rpc[WS_METHODS.providerAuthSubscribe]({ instanceId }).pipe(
          Stream.filter((state) => state.phase === "failed"),
        ),
      );
      expect(finished.message).toBe("Sign-in timed out. Start again.");
      expect(finished.interaction).toBeNull();
      expect(
        cloud.pools
          .objectFor(`${userId}:personal`)
          .cliProxyApi.authorizeDevice(started.interaction.userCode),
      ).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps polling after expiry when CLIProxyAPI has already begun saving", () =>
    Effect.gen(function* () {
      const { rpc, cloud } = yield* client();
      const instanceId = ProviderInstanceId.make(poolInstanceId("codex", "personal"));
      const fake = cloud.pools.objectFor(`${userId}:personal`).cliProxyApi;
      fake.setDeviceExpiresIn(1);
      const started = yield* rpc[WS_METHODS.providerAuthStart]({ instanceId });
      if (started.interaction?.type !== "deviceCode") throw new Error("Expected a device code");
      expect(fake.beginLoginSave(started.interaction.userCode)).toBe(true);

      yield* TestClock.adjust("1 second");
      const finishing = yield* first(
        rpc[WS_METHODS.providerAuthSubscribe]({ instanceId }).pipe(
          Stream.filter((state) => state.phase === "verifying"),
        ),
      );
      expect(finishing.message).toBe("Sign-in is finishing.");
      expect(finishing.interaction).toBeNull();

      expect(fake.authorizeDevice(started.interaction.userCode)).toBe(true);
      yield* TestClock.adjust("1 second");
      const finished = yield* first(
        rpc[WS_METHODS.providerAuthSubscribe]({ instanceId }).pipe(
          Stream.filter((state) => state.phase === "succeeded" || state.phase === "failed"),
        ),
      );
      expect(finished.phase).toBe("succeeded");
    }).pipe(Effect.scoped),
  );

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
      // Add account offers only what cloud pools take.
      expect(before.config.environment.capabilities.poolFeatures).toEqual(["claude", "codex"]);
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
      const handBack = {
        instanceId,
        flowId: started.flowId!,
        callbackUrl: `http://localhost:54545/callback?code=c&state=${loginState}`,
      };
      expect((yield* rpc[WS_METHODS.providerAuthComplete](handBack)).phase).toBe("verifying");
      // A second click while it checks changes nothing and fails nothing.
      expect(["verifying", "succeeded"]).toContain(
        (yield* rpc[WS_METHODS.providerAuthComplete](handBack)).phase,
      );
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

  it.live("keeps the pool views live after a read fails", () =>
    Effect.gen(function* () {
      const { rpc, cloud } = yield* client();
      const failed = yield* personalDownOnce(cloud);
      const views = yield* rpc[WS_METHODS.accountPoolSubscribeViews]({}).pipe(
        Stream.map((all) => all.map((view) => view.name)),
        Stream.takeUntil((names) => names.includes("Work")),
        Stream.runLast,
        Effect.forkScoped,
      );
      yield* Deferred.await(failed);

      // The section menu's pool list picks up a pool created after the failure.
      yield* rpc[WS_METHODS.accountPoolCreate]({ name: "Work" });
      expect(yield* Fiber.join(views)).toEqual(Option.some(["Personal", "Work"]));
    }).pipe(Effect.scoped),
  );

  it.live("brings the pools into the config once they can be read", () =>
    Effect.gen(function* () {
      const { rpc, cloud } = yield* client();
      yield* personalDownOnce(cloud);
      const personalClaude = ProviderInstanceId.make(poolInstanceId("claude", "personal"));
      const events = yield* rpc[WS_METHODS.subscribeServerConfig]({}).pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "providerStatuses" &&
            event.payload.providers.some((provider) => provider.instanceId === personalClaude),
        ),
        Stream.runCollect,
      );
      // The config goes out without pools first, then picks them up.
      const [snapshot] = events;
      expect(snapshot?.type === "snapshot" && snapshot.config.providers).toEqual([]);
      expect(events.at(-1)?.type).toBe("providerStatuses");
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
