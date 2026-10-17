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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import { memorySignInBrowsers } from "../browser/memorySignInBrowsers.ts";
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
  options: Parameters<typeof makeMemoryCloud>[0] = {},
) =>
  Effect.gen(function* () {
    const cloud = makeMemoryCloud(options);
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
      const started = yield* rpc[WS_METHODS.providerAuthStart]({ instanceId });
      const other = yield* rpc[WS_METHODS.providerAuthStart]({ instanceId: otherId });
      const otherState = new URL(other.authorizationUrl!).searchParams.get("state");
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

  it.live.each([
    { provider: "claude", driver: "claudeAgent" },
    { provider: "codex", driver: "codex" },
  ] as const)(
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
        expect(started.interaction).toMatchObject({ type: "browser", acceptsCode: true });
        expect(
          (yield* config(rpc)).sources.find((source) => source.id === poolSourceId(work.id))
            ?.accounts,
        ).toEqual([expect.objectContaining({ driver })]);
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

  describe("in a cloud browser (#205)", () => {
    const signedInUntil = (rpc: Rpc, instanceId: ProviderInstanceId) =>
      rpc[WS_METHODS.providerAuthSubscribe]({ instanceId }).pipe(
        Stream.filter((state) => state.phase === "succeeded" || state.phase === "failed"),
        (stream) => first(stream),
      );

    it.live("adds an account with nothing to copy or paste", () =>
      Effect.gen(function* () {
        const browsers = memorySignInBrowsers();
        const { rpc } = yield* client(undefined, { signInBrowsers: browsers.service });
        const instanceId = ProviderInstanceId.make(poolInstanceId("codex", "personal"));

        const started = yield* rpc[WS_METHODS.providerAuthStart]({
          instanceId,
          callbackMode: "client",
        });
        // The login runs in a browser the cloud holds; the person signs in through its live view.
        expect(started.phase).toBe("waiting");
        expect(started.interaction).toEqual({
          type: "liveView",
          id: started.flowId,
          url: "https://live.kernel.test/1",
          site: "login.example.test",
          viewport: { width: 390, height: 844 },
        });
        expect(browsers.opened.map((browser) => browser.loginUrl)).toEqual([
          started.authorizationUrl,
        ]);

        // The provider redirects that browser to localhost; the cloud hands it to the pool.
        yield* browsers.land();
        expect((yield* signedInUntil(rpc, instanceId)).phase).toBe("succeeded");
        expect(browsers.opened[0]?.closed).toBe(true);
        const { sources } = yield* config(rpc);
        expect(sources.find((source) => source.id === poolSourceId("personal"))?.accounts).toEqual([
          expect.objectContaining({ driver: "codex" }),
        ]);
      }).pipe(Effect.scoped),
    );

    it.live("closes the browser when the person cancels", () =>
      Effect.gen(function* () {
        const browsers = memorySignInBrowsers();
        const { rpc } = yield* client(undefined, { signInBrowsers: browsers.service });
        const instanceId = ProviderInstanceId.make(poolInstanceId("claude", "personal"));
        const started = yield* rpc[WS_METHODS.providerAuthStart]({ instanceId });
        const cancelled = yield* rpc[WS_METHODS.providerAuthCancel]({
          instanceId,
          flowId: started.flowId!,
        });
        expect(cancelled.phase).toBe("cancelled");
        expect(browsers.opened[0]?.closed).toBe(true);
      }).pipe(Effect.scoped),
    );

    it.live("says why when the browser closes before the sign-in ends", () =>
      Effect.gen(function* () {
        const browsers = memorySignInBrowsers();
        const { rpc } = yield* client(undefined, { signInBrowsers: browsers.service });
        const instanceId = ProviderInstanceId.make(poolInstanceId("claude", "personal"));
        yield* rpc[WS_METHODS.providerAuthStart]({ instanceId });
        yield* browsers.goAway;
        const ended = yield* signedInUntil(rpc, instanceId);
        expect(ended).toMatchObject({
          phase: "failed",
          message: "The sign-in browser closed. Start again.",
          interaction: null,
        });
        expect(browsers.opened[0]?.closed).toBe(true);
      }).pipe(Effect.scoped),
    );

    it.live("shows Kernel's refusal plainly", () =>
      Effect.gen(function* () {
        const browsers = memorySignInBrowsers();
        browsers.refuseWith(
          "Kernel couldn't open a sign-in browser: too many browsers (org_limit_exceeded, HTTP 429).",
        );
        const { rpc } = yield* client(undefined, { signInBrowsers: browsers.service });
        const instanceId = ProviderInstanceId.make(poolInstanceId("claude", "personal"));
        const started = yield* rpc[WS_METHODS.providerAuthStart]({ instanceId });
        expect(started).toMatchObject({
          phase: "failed",
          message:
            "Kernel couldn't open a sign-in browser: too many browsers (org_limit_exceeded, HTTP 429).",
        });
      }).pipe(Effect.scoped),
    );
  });

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
