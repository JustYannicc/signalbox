import {
  type ProviderAuthCancelInput,
  type ProviderAuthCompleteInput,
  type ProviderAuthStartInput,
  type ProviderAuthState,
  type ProviderInstanceId,
  ProviderSetupError,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as SignInBrowsers from "../browser/SignInBrowsers.ts";
import type { PoolActor, PoolRejectedError } from "../pool/PoolEngine.ts";
import * as PoolDirectory from "../pool/PoolDirectory.ts";
import * as UserPools from "./UserPools.ts";

/**
 * Signing an account into one of the user's pools, behind the same
 * `provider.auth.*` calls a self-hosted hub serves (see
 * `apps/server/src/accountHub/hubSignIn.ts`). The pool's CLIProxyAPI runs the
 * provider's login, which ends on a `localhost` redirect no client reaches.
 * With Kernel, the login opens in a cloud browser that catches that redirect
 * and hands it to the pool (`SignInBrowsers`, #205): the person only signs in,
 * through the browser's live view. Without it, the person signs in in their
 * own browser and pastes the final address back. The account is saved in the
 * pool, never on a client.
 *
 * Flows live in the user's object while it runs; one that outlives the object
 * is simply started again.
 */

/** CLIProxyAPI forgets a login after 30 minutes. */
const LOGIN_TTL_MS = 30 * 60_000;
/** Every second while the user is likely still at it, then every 5 seconds. */
const pollDelay = (elapsedMs: number) => (elapsedMs < 60_000 ? 1_000 : 5_000);
/** Once the user hands back the redirect, the account lands within a second or two. */
const VERIFY_POLL_MS = 250;
/** Fast polls after the hand-back, 15 seconds' worth; then the usual pace again. */
const VERIFY_POLLS = 60;

interface Login {
  readonly flowId: string;
  readonly objectName: string;
  readonly state: string;
  /** Done once the redirect was handed back: the poll wakes and speeds up. */
  readonly handedBack: Deferred.Deferred<void>;
  readonly fiber: Fiber.Fiber<void>;
  /** Holds the sign-in browser, if the login runs in one. */
  readonly browserScope: Scope.Closeable;
}

export class PoolSignIns extends Context.Service<
  PoolSignIns,
  {
    readonly subscribe: (
      actor: PoolActor,
      input: { readonly instanceId: ProviderInstanceId },
    ) => Stream.Stream<ProviderAuthState>;
    readonly start: (
      actor: PoolActor,
      input: ProviderAuthStartInput,
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
    readonly complete: (
      actor: PoolActor,
      input: ProviderAuthCompleteInput,
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
    readonly cancel: (
      actor: PoolActor,
      input: ProviderAuthCancelInput,
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
  }
>()("@signalbox/cloud/user/PoolSignIns") {}

const idle = (instanceId: ProviderInstanceId): ProviderAuthState => ({
  instanceId,
  phase: "idle",
  flowId: null,
  authorizationUrl: null,
  expiresAt: null,
  message: null,
  interaction: null,
});

const make = Effect.gen(function* () {
  const pools = yield* UserPools.UserPools;
  const browsers = yield* SignInBrowsers.SignInBrowsers;
  const directory = yield* PoolDirectory.PoolDirectory;
  const crypto = yield* Crypto.Crypto;
  // One start at a time, so two devices starting at once can't strand a login.
  const starting = yield* Semaphore.make(1);
  // Only for instances of the user's own pools.
  const states = new Map<string, SubscriptionRef.SubscriptionRef<ProviderAuthState>>();
  const logins = new Map<string, Login>();

  const stateOf = (instanceId: ProviderInstanceId) =>
    Effect.gen(function* () {
      const existing = states.get(instanceId);
      if (existing) return existing;
      const ref = yield* SubscriptionRef.make(idle(instanceId));
      states.set(instanceId, ref);
      return ref;
    });

  const update = (instanceId: ProviderInstanceId, patch: Partial<ProviderAuthState>) =>
    Effect.flatMap(stateOf(instanceId), (ref) =>
      SubscriptionRef.updateAndGet(ref, (current) => ({ ...current, ...patch })),
    );

  const setupError = (instanceId: ProviderInstanceId, operation: string) => (detail: string) =>
    new ProviderSetupError({ instanceId, operation, detail });

  const reason = PoolDirectory.poolErrorMessage;

  /** Moves this flow from `from` to `to`, if it is still at `from`; says whether it did. */
  const advance = (
    ref: SubscriptionRef.SubscriptionRef<ProviderAuthState>,
    flowId: string,
    from: ProviderAuthState["phase"],
    patch: Partial<ProviderAuthState>,
  ) =>
    SubscriptionRef.modify(ref, (state) =>
      state.flowId === flowId && state.phase === from
        ? ([true, { ...state, ...patch }] as const)
        : ([false, state] as const),
    );

  /** Polls the pool until the login is saved, fails, or expires. */
  const awaitLogin = (
    actor: PoolActor,
    instanceId: ProviderInstanceId,
    pool: PoolDirectory.PoolHandle,
    login: Pick<Login, "flowId" | "state" | "handedBack">,
  ) => {
    const failed = (error: PoolDirectory.PoolObjectError | PoolRejectedError) =>
      Effect.flatMap(reason(error), (message) =>
        update(instanceId, { phase: "failed", message, interaction: null }),
      );
    return Effect.gen(function* () {
      const state = login.state;
      for (let elapsed = 0, fast = 0; ;) {
        const handedBack = yield* Deferred.isDone(login.handedBack);
        if (handedBack && fast < VERIFY_POLLS) {
          fast += 1;
          yield* Effect.sleep(VERIFY_POLL_MS);
        } else {
          const delay = pollDelay(elapsed);
          elapsed += delay;
          yield* handedBack
            ? Effect.sleep(delay)
            : Deferred.await(login.handedBack).pipe(
                Effect.timeoutOrElse({ duration: delay, orElse: () => Effect.void }),
              );
        }
        const status = yield* pool.loginStatus(actor, state);
        if (status.status === "error") {
          yield* update(instanceId, {
            phase: "failed",
            message: status.error
              ? `Sign-in failed: ${status.error}.`
              : "Sign-in failed. Start again.",
            interaction: null,
          });
          return;
        }
        if (status.status === "wait") continue;
        yield* update(instanceId, { phase: "succeeded", message: "Signed in.", interaction: null });
        yield* pools.refresh(actor).pipe(Effect.ignore);
        return;
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: LOGIN_TTL_MS,
        orElse: () =>
          update(instanceId, {
            phase: "failed",
            message: "Sign-in timed out. Start again.",
            interaction: null,
          }),
      }),
      Effect.catchTags({ PoolRejectedError: failed, PoolObjectError: failed }),
      Effect.asVoid,
      // A newer sign-in on the same instance is not this one's to clear.
      Effect.ensuring(
        Effect.sync(() => {
          if (logins.get(instanceId)?.flowId === login.flowId) logins.delete(instanceId);
        }),
      ),
    );
  };

  /**
   * Hands the redirect the sign-in browser caught to the pool, then leaves the
   * rest to `awaitLogin`. Ends the sign-in itself, and the pool's login with
   * it, only when the hand-back fails or the browser closed before the person
   * finished; a flow that moved on some other way is `awaitLogin`'s to end.
   */
  const catchInBrowser = (
    actor: PoolActor,
    instanceId: ProviderInstanceId,
    pool: PoolDirectory.PoolHandle,
    browser: SignInBrowsers.SignInBrowser,
    login: Pick<Login, "flowId" | "state" | "handedBack">,
  ) =>
    Effect.gen(function* () {
      const ref = yield* stateOf(instanceId);
      const { flowId } = login;
      const endedHere = (from: ProviderAuthState["phase"], message: string) =>
        advance(ref, flowId, from, { phase: "failed", message, interaction: null }).pipe(
          Effect.flatMap((ended) =>
            ended ? pool.cancelLogin(actor, login.state).pipe(Effect.ignore) : Effect.never,
          ),
        );
      const redirected = yield* Effect.result(browser.redirected);
      if (redirected._tag === "Failure") {
        return yield* endedHere("waiting", "The sign-in browser closed. Start again.");
      }
      const callbackUrl = redirected.success;
      if (!(yield* advance(ref, flowId, "waiting", { phase: "verifying", message: null }))) {
        return yield* Effect.never;
      }
      const done = yield* Effect.result(pool.completeLogin(actor, callbackUrl));
      if (done._tag === "Success") {
        yield* Deferred.succeed(login.handedBack, undefined);
        return yield* Effect.never;
      }
      yield* endedHere("verifying", yield* reason(done.failure));
    });

  const stopLogin = (actor: PoolActor, instanceId: string) =>
    Effect.gen(function* () {
      const login = logins.get(instanceId);
      if (!login) return;
      logins.delete(instanceId);
      yield* Fiber.interrupt(login.fiber);
      // A fiber interrupted before it ran never reached its own close.
      yield* Scope.close(login.browserScope, Exit.void);
      yield* directory
        .forPool(login.objectName)
        .cancelLogin(actor, login.state)
        .pipe(Effect.ignore);
    });

  const start: PoolSignIns["Service"]["start"] = (actor, input) =>
    starting.withPermits(1)(
      Effect.gen(function* () {
        const { instanceId } = input;
        const fail = setupError(instanceId, "start");
        const target = yield* pools
          .poolOfInstance(actor, instanceId)
          .pipe(Effect.mapError((error) => fail(error.detail)));
        if (target === null) return yield* fail("That provider isn't one of your pools.");
        yield* stopLogin(actor, instanceId);
        const flowId = yield* Effect.orDie(crypto.randomUUIDv4());
        yield* update(instanceId, {
          phase: "starting",
          flowId,
          authorizationUrl: null,
          expiresAt: null,
          message: null,
          interaction: null,
        });
        const pool = directory.forPool(target.pool.objectName);
        const started = yield* pool.startLogin(actor, target.kind).pipe(Effect.result);
        if (started._tag === "Failure") {
          const message = yield* reason(started.failure);
          return yield* update(instanceId, { phase: "failed", message });
        }
        const login = started.success;
        // The sign-in browser lives until the login ends, whichever way.
        const browserScope = yield* Scope.make();
        const opened = yield* browsers.open(login.url).pipe(
          Scope.provide(browserScope),
          // The client left while it opened: nothing else would close it.
          Effect.onInterrupt(() => Scope.close(browserScope, Exit.void)),
          Effect.result,
        );
        if (opened._tag === "Failure") {
          yield* Scope.close(browserScope, Exit.void);
          yield* pool.cancelLogin(actor, login.state).pipe(Effect.ignore);
          return yield* update(instanceId, { phase: "failed", message: opened.failure.message });
        }
        // Until the fiber below holds the browser, an interruption would leave it running.
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const browser = opened.success;
            const now = yield* Clock.currentTimeMillis;
            const state = yield* update(instanceId, {
              phase: "waiting",
              authorizationUrl: login.url,
              expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + LOGIN_TTL_MS)),
              interaction: browser
                ? {
                    type: "liveView",
                    id: flowId,
                    url: browser.liveViewUrl,
                    site: browser.site,
                    viewport: browser.viewport,
                  }
                : login.user_code
                  ? { type: "deviceCode", id: flowId, url: login.url, userCode: login.user_code }
                  : {
                      type: "browser",
                      id: flowId,
                      url: login.url,
                      requiresConsent: false,
                      acceptsCallback: true,
                    },
            });
            const handedBack = yield* Deferred.make<void>();
            const waiting = awaitLogin(actor, instanceId, pool, {
              flowId,
              state: login.state,
              handedBack,
            });
            // Outlives this call and the socket that made it; the object holds it.
            // Interruptible again, so a newer sign-in or a cancel can stop it.
            const fiber = yield* Effect.forkDetach(
              restore(
                browser
                  ? Effect.raceFirst(
                      waiting,
                      catchInBrowser(actor, instanceId, pool, browser, {
                        flowId,
                        state: login.state,
                        handedBack,
                      }),
                    )
                  : waiting,
              ).pipe(Effect.ensuring(Scope.close(browserScope, Exit.void))),
            );
            logins.set(instanceId, {
              flowId,
              objectName: target.pool.objectName,
              state: login.state,
              handedBack,
              fiber,
              browserScope,
            });
            return state;
          }),
        );
      }),
    );

  const currentLogin = (instanceId: ProviderInstanceId, flowId: string, operation: string) => {
    const login = logins.get(instanceId);
    return login && login.flowId === flowId
      ? Effect.succeed(login)
      : Effect.fail(setupError(instanceId, operation)("This sign-in has ended. Start again."));
  };

  const complete: PoolSignIns["Service"]["complete"] = (actor, input) =>
    Effect.gen(function* () {
      const { instanceId, flowId } = input;
      const login = logins.get(instanceId);
      const ref = states.get(instanceId);
      // Handed back already (a second click, another device): that one finishes it.
      const handedBack = ref ? yield* SubscriptionRef.get(ref) : null;
      if (
        handedBack?.flowId === flowId &&
        (handedBack.phase === "verifying" || handedBack.phase === "succeeded")
      ) {
        return handedBack;
      }
      if (!login || login.flowId !== flowId || !ref) {
        return yield* setupError(instanceId, "complete")("This sign-in has ended. Start again.");
      }
      if (!(yield* advance(ref, flowId, "waiting", { phase: "verifying", message: null }))) {
        return yield* SubscriptionRef.get(ref);
      }
      const done = yield* directory
        .forPool(login.objectName)
        .completeLogin(actor, input.callbackUrl)
        .pipe(Effect.result);
      if (done._tag === "Success") {
        yield* Deferred.succeed(login.handedBack, undefined);
        return yield* SubscriptionRef.get(ref);
      }
      const message = yield* reason(done.failure);
      // Only a hand-back still being checked goes back to waiting; one that ended stays ended.
      if (!(yield* advance(ref, flowId, "verifying", { phase: "waiting", message }))) {
        return yield* SubscriptionRef.get(ref);
      }
      return yield* setupError(instanceId, "complete")(message);
    });

  const cancel: PoolSignIns["Service"]["cancel"] = (actor, input) =>
    Effect.gen(function* () {
      yield* currentLogin(input.instanceId, input.flowId, "cancel");
      yield* stopLogin(actor, input.instanceId);
      return yield* update(input.instanceId, {
        phase: "cancelled",
        message: null,
        interaction: null,
      });
    });

  return PoolSignIns.of({
    subscribe: (actor, { instanceId }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const target = yield* pools
            .poolOfInstance(actor, instanceId)
            .pipe(Effect.orElseSucceed(() => null));
          // Nothing to sign in to: idle, without keeping state for it.
          if (target === null) return Stream.concat(Stream.make(idle(instanceId)), Stream.never);
          return SubscriptionRef.changes(yield* stateOf(instanceId));
        }),
      ),
    start,
    complete,
    cancel,
  });
});

export const layer = Layer.effect(PoolSignIns, make);
