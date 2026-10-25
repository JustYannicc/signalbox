import {
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  type AuthEnvironmentScope,
  EnvironmentId,
  ProviderInstanceId,
  WS_METHODS,
} from "@t3tools/contracts";
import { poolInstanceId } from "@t3tools/contracts/accountHub";
import { operations } from "@signalbox/api/catalog";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";
import * as SqlClient from "effect/sql/SqlClient";

import { callOperation } from "../api/apiCall.ts";
import { makeMemoryCloud } from "../testing.ts";
import * as CloudRpc from "./rpc.ts";

const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };
const userId = "auth-user";
const instanceId = ProviderInstanceId.make(poolInstanceId("claude", "personal"));
const first = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
  stream.pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.map(([item]) => item!),
  );

const setup = Effect.gen(function* () {
  const cloud = makeMemoryCloud();
  yield* cloud.userDirectory.forUser(userId).recordSignIn({ id: userId, email: "a@b.c" });
  const connect = (
    sid: string,
    scopes: ReadonlyArray<AuthEnvironmentScope> = [
      AuthProvidersManageScope,
      AuthOrchestrationReadScope,
    ],
  ) =>
    RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
      Effect.provide(
        Layer.mergeAll(
          CloudRpc.layerHandlers({ identity, userId, sid }),
          CloudRpc.layerScopeAuthorization(scopes),
        ).pipe(Layer.provide(cloud.layerFor(userId))),
      ),
    );
  const rpc = yield* connect("web");
  yield* first(rpc[WS_METHODS.accountPoolSubscribe]({}));
  const object = cloud.pools.objectFor(`${userId}:personal`);
  const pool = cloud.pools.directory.forPool(`${userId}:personal`);
  return { cloud, connect, rpc, object, pool };
});

describe("cloud provider auth actions", () => {
  it.live(
    "routes browser responses exactly, rejects replays, and shares cancel/retry across devices",
    () =>
      Effect.gen(function* () {
        const { rpc, connect, object } = yield* setup;
        const phone = yield* connect("phone");
        const started = yield* rpc[WS_METHODS.providerAuthStart]({ instanceId });
        const request = {
          instanceId,
          flowId: started.flowId!,
          interactionId: started.interaction!.id,
          response: { type: "browser", action: "accept" } as const,
        };
        for (const invalid of [
          { ...request, flowId: "old" },
          { ...request, interactionId: "foreign" },
          { ...request, instanceId: ProviderInstanceId.make(poolInstanceId("codex", "personal")) },
          {
            ...request,
            response: { type: "credentials", values: { code: "never-submit" } } as const,
          },
        ]) {
          expect((yield* Effect.flip(rpc[WS_METHODS.providerAuthRespond](invalid)))._tag).toBe(
            "ProviderSetupError",
          );
        }
        expect((yield* phone[WS_METHODS.providerAuthRespond](request)).phase).toBe("waiting");
        expect(object.cliProxyApi.accounts.size).toBe(0);
        const cancelled = yield* phone[WS_METHODS.providerAuthRespond]({
          ...request,
          response: { type: "browser", action: "decline" },
        });
        expect(cancelled.phase).toBe("cancelled");
        expect((yield* first(rpc[WS_METHODS.providerAuthSubscribe]({ instanceId }))).phase).toBe(
          "cancelled",
        );
        expect((yield* Effect.flip(rpc[WS_METHODS.providerAuthRespond](request)))._tag).toBe(
          "ProviderSetupError",
        );
        const retry = yield* rpc[WS_METHODS.providerAuthStart]({ instanceId });
        expect(retry.flowId).not.toBe(started.flowId);
        yield* rpc[WS_METHODS.providerAuthComplete]({
          instanceId,
          flowId: retry.flowId!,
          callbackUrl: "correct-code",
        });
        expect(
          (yield* first(
            phone[WS_METHODS.providerAuthSubscribe]({ instanceId }).pipe(
              Stream.filter((state) => state.phase === "succeeded"),
            ),
          )).phase,
        ).toBe("succeeded");
        expect(object.cliProxyApi.accounts.size).toBe(1);
        expect(
          (yield* Effect.flip(
            phone[WS_METHODS.providerAuthRespond]({
              ...request,
              flowId: retry.flowId!,
              interactionId: retry.interaction!.id,
            }),
          ))._tag,
        ).toBe("ProviderSetupError");
      }).pipe(Effect.scoped),
  );

  it.effect("requires provider-management scope for respond and logout", () =>
    Effect.gen(function* () {
      const { connect } = yield* setup;
      const rpc = yield* connect("read-only", [AuthOrchestrationReadScope]);
      expect(
        (yield* Effect.flip(
          rpc[WS_METHODS.providerAuthRespond]({
            instanceId,
            flowId: "flow",
            interactionId: "interaction",
            response: { type: "browser", action: "accept" },
          }),
        ))._tag,
      ).toBe("EnvironmentAuthorizationError");
      expect(
        (yield* Effect.flip(
          rpc[WS_METHODS.providerAuthLogout]({ instanceId, accountId: "target.json" }),
        ))._tag,
      ).toBe("EnvironmentAuthorizationError");
    }).pipe(Effect.scoped),
  );

  it.live("rechecks pool admin access without losing a waiting interaction", () =>
    Effect.gen(function* () {
      const { rpc, object } = yield* setup;
      const started = yield* rpc[WS_METHODS.providerAuthStart]({ instanceId });
      yield* Effect.promise(() =>
        object.runtime.runPromise(
          SqlClient.SqlClient.use(
            (sql) => sql`UPDATE grants SET role = 'member' WHERE user_id = ${userId}`,
          ),
        ),
      );
      const error = yield* Effect.flip(
        rpc[WS_METHODS.providerAuthRespond]({
          instanceId,
          flowId: started.flowId!,
          interactionId: started.interaction!.id,
          response: { type: "browser", action: "decline" },
        }),
      );
      expect(error.message).toContain("admin");
      expect(
        (yield* Effect.flip(
          rpc[WS_METHODS.providerAuthLogout]({ instanceId, accountId: "target.json" }),
        )).message,
      ).toContain("admin");
      expect((yield* first(rpc[WS_METHODS.providerAuthSubscribe]({ instanceId }))).phase).toBe(
        "waiting",
      );
      yield* Effect.promise(() =>
        object.runtime.runPromise(
          SqlClient.SqlClient.use(
            (sql) => sql`UPDATE grants SET role = 'admin' WHERE user_id = ${userId}`,
          ),
        ),
      );
      yield* rpc[WS_METHODS.providerAuthCancel]({ instanceId, flowId: started.flowId! });
    }).pipe(Effect.scoped),
  );

  it.effect("keeps responses human-only at the public API boundary", () =>
    Effect.gen(function* () {
      const { cloud } = yield* setup;
      const operation = operations.find((entry) => entry.name === "provider.auth.respond")!;
      const result = yield* callOperation({
        operation,
        body: {
          instanceId,
          flowId: "flow",
          interactionId: "interaction",
          response: { type: "browser", action: "accept" },
        },
        follow: false,
        caller: {
          userId,
          kind: "agent",
          scopes: [AuthProvidersManageScope],
          credentialId: "agent-key",
        },
        identity,
      }).pipe(Effect.provide(cloud.layerFor(userId)));
      expect(result).toMatchObject({
        _tag: "json",
        status: 403,
        body: { error: { code: "people_only" } },
      });
      expect(operation.agentCallable).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.live(
    "invalidates only the selected credential, retains the account, and refreshes a second device",
    () =>
      Effect.gen(function* () {
        const { rpc, connect, pool, object } = yield* setup;
        const phone = yield* connect("phone");
        const actor = { userId };
        for (let n = 0; n < 2; n += 1) {
          const login = yield* pool.startLogin(actor, "claude", "manual");
          yield* pool.completeLogin(actor, { state: login.state, code: "code" });
          yield* pool.loginStatus(actor, login.state);
        }
        const [target, unrelated] = (yield* pool.accounts(actor)).accounts;
        if (!target || !unrelated) throw new Error("Expected two accounts");
        yield* rpc[WS_METHODS.serverRefreshProviders]({});
        const ready = yield* Deferred.make<void>();
        const updated = yield* phone[WS_METHODS.subscribeServerConfig]({
          usageLimitSources: true,
        }).pipe(
          Stream.tap(() => Deferred.succeed(ready, undefined)),
          Stream.filter(
            (event) =>
              event.type === "usageLimitSourcesUpdated" &&
              event.payload.sources.some((source) =>
                source.accounts?.some((account) => account.id === target.name && account.signedOut),
              ),
          ),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(ready);
        expect(
          (yield* Effect.flip(rpc[WS_METHODS.providerAuthLogout]({ instanceId }))).message,
        ).toContain("Choose the account");
        expect(
          (yield* Effect.flip(
            rpc[WS_METHODS.providerAuthLogout]({
              instanceId: ProviderInstanceId.make(poolInstanceId("codex", "personal")),
              accountId: target.name,
            }),
          )).message,
        ).toContain("does not belong");
        expect(
          (yield* rpc[WS_METHODS.providerAuthLogout]({ instanceId, accountId: target.name })).phase,
        ).toBe("idle");
        expect((yield* Fiber.join(updated)).length).toBe(1);
        expect(object.cliProxyApi.accounts.has(target.name)).toBe(false);
        expect(object.cliProxyApi.accounts.has(unrelated.name)).toBe(true);
        expect((yield* pool.accounts(actor)).accounts).toEqual([
          expect.objectContaining({ name: target.name, signedOut: true }),
          expect.objectContaining({ name: unrelated.name, signedOut: false }),
        ]);
        // Logout is replayable; it does not become pool-account deletion.
        yield* rpc[WS_METHODS.providerAuthLogout]({ instanceId, accountId: target.name });
        const otherLogin = yield* pool.startLogin(actor, "claude", "manual");
        yield* pool.cancelLogin(actor, otherLogin.state);
        expect(
          (yield* pool.accounts(actor)).accounts.some(
            (account) => account.name === target.name && account.signedOut,
          ),
        ).toBe(true);
        // A new credential under the original name restores that account.
        object.cliProxyApi.accounts.set(target.name, {
          type: "claude",
          email: target.email!,
          disabled: false,
        });
        const reauth = yield* pool.startLogin(actor, "claude", "manual");
        yield* pool.cancelLogin(actor, reauth.state);
        expect(
          (yield* pool.accounts(actor)).accounts.find((account) => account.name === target.name)
            ?.signedOut,
        ).toBe(false);
      }).pipe(Effect.scoped),
  );
});
