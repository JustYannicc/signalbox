import { listedNames } from "@signalbox/runner-protocol/SecretPlaceholders";
import type { SecretValue } from "@signalbox/runner-protocol/SecretScrubber";
import {
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadProjection,
  RuntimeRequestId,
  TurnItemId,
} from "@t3tools/contracts";
import type { OnePasswordEnvironmentId } from "@t3tools/contracts/signalboxFolders";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { UserDirectory } from "../../user/UserDirectory.ts";
import { systemNoticeEvents } from "../runner/runnerEvents.ts";
import { activeRun } from "../runLifecycle.ts";
import { approvalRequestEvents } from "../runtimeRequests.ts";
import * as ThreadEngine from "../ThreadEngine.ts";
import { ThreadStore } from "../ThreadStore.ts";
import {
  countSecretAsks,
  markAskKept,
  readSecretAsks,
  readSecretSources,
  saveSecretAsk,
  type SecretAsk,
} from "./secretSendTables.ts";

/**
 * Whether the thread's machine may send its secrets somewhere (#592): the
 * decision behind the egress check (`ThreadEgress.ts`), which tells this
 * object the host a request goes to and the secrets in it, by placeholder or
 * by value.
 *
 * A secret goes to a host the person allowed: always (kept in their object
 * per Environment, name and host, `user/SecretSends.ts`), or for the rest of
 * the turn. Anything else asks them once, as an approval on the thread
 * (`runtimeRequests.ts`): "Send it this turn", "Always send it there", or no.
 * A send that comes while they haven't answered waits a little, then is
 * refused with a message the agent reads; asking again doesn't ask twice. A
 * "no" holds for the rest of the turn, and every turn asks afresh.
 *
 * The first send of each secret to each host in a turn is a row in the
 * thread's transcript, so anyone can see where it went.
 */

export type SendAnswer =
  | { readonly _tag: "allowed" }
  | { readonly _tag: "refused"; readonly message: string }
  | { readonly _tag: "waiting"; readonly message: string };

/** One request's question to the gate: its host, the secrets it carries, how long it may wait. */
export interface SendRequest {
  readonly host: string;
  readonly names: ReadonlyArray<string>;
  readonly waitMs: number;
}

export class ThreadSends extends Context.Service<
  ThreadSends,
  {
    /** The values the thread's machine registered (`runner/secretValues.ts`). Never log them. */
    readonly secrets: Effect.Effect<ReadonlyArray<SecretValue>>;
    /** Whether `names` may go to `host` now; waits up to `waitMs` for the person's answer. */
    readonly authorize: (input: SendRequest) => Effect.Effect<SendAnswer>;
    /** After the thread changed: wakes sends waiting on an answer, and keeps "Always" answers. */
    readonly settle: Effect.Effect<void>;
  }
>()("@signalbox/cloud/thread/egress/ThreadSends") {}

/** The answers a send ask offers, in the order clients lay them out. */
const askOptions = (host: string) =>
  [
    { decision: "decline", label: "Don't send" },
    { decision: "acceptAlways", label: `Always send to ${host}` },
    { decision: "accept", label: "Send this turn" },
  ] as const;

const askRequestId = (runId: string, ordinal: number) =>
  RuntimeRequestId.make(`runtime-request:secret-send:${runId}:${ordinal}`);

/** What the person said to each ask, from the thread's own events. */
const answersOf = (projection: OrchestrationV2ThreadProjection) => {
  const requests = new Map(projection.runtimeRequests.map((request) => [request.id, request]));
  return (ask: SecretAsk) => answerOf(requests.get(RuntimeRequestId.make(ask.requestId)));
};

/** "pending" while they haven't answered; null for an ask whose request never committed. */
const answerOf = (request: OrchestrationV2RuntimeRequest | undefined) => {
  if (request === undefined) return null;
  if (request.status === "pending") return "pending" as const;
  return request.status === "resolved" ? (request.decision ?? null) : "expired";
};

export const layer = Layer.effect(
  ThreadSends,
  Effect.gen(function* () {
    const engine = yield* ThreadEngine.ThreadEngine;
    const store = yield* ThreadStore;
    const sql = yield* SqlClient.SqlClient;
    const users = yield* UserDirectory;
    /** Sends waiting on an ask, by its request id; woken by `settle`. */
    const waiting = new Map<string, Deferred.Deferred<void>>();
    /** One ask at a time, so sends made together ask once. */
    const asking = yield* Semaphore.make(1);
    /** Each turn, host and secret already in the transcript, so a send doesn't wait on the engine to say so again. */
    const noted = new Set<string>();
    const withSql = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      Effect.provideService(effect, SqlClient.SqlClient, sql);

    const secrets: ThreadSends["Service"]["secrets"] = store.secretValues.pipe(
      Effect.map(({ values }) => values),
      Effect.orDie,
    );

    /** The names the owner always lets go to `host`; none when their object can't say. */
    const alwaysAllowed = (
      owner: string,
      host: string,
      names: ReadonlyArray<string>,
      sources: ReadonlyMap<string, OnePasswordEnvironmentId>,
    ) => {
      const sends = names.flatMap((name) => {
        const environmentId = sources.get(name);
        return environmentId === undefined ? [] : [{ environmentId, name }];
      });
      return sends.length === 0
        ? Effect.succeed(new Set<string>())
        : users
            .forUser(owner)
            .secretSendsAllowed({ host, sends })
            .pipe(
              Effect.map((allowed) => new Set(allowed)),
              Effect.catch((error) =>
                Effect.as(
                  Effect.logWarning("reading the owner's secret sends failed", {
                    reason: error._tag,
                  }),
                  new Set<string>(),
                ),
              ),
            );
    };

    /** A transcript row for each secret's first send to `host` this turn. */
    const noteSent = (run: OrchestrationV2Run, host: string, names: ReadonlyArray<string>) => {
      const fresh = names.filter((name) => !noted.has(`${run.id} ${host} ${name}`));
      if (fresh.length === 0) return Effect.void;
      for (const name of fresh) noted.add(`${run.id} ${host} ${name}`);
      return engine.apply((projection, ctx) =>
        Effect.succeed({
          events:
            projection === null
              ? []
              : fresh.flatMap((name) => {
                  const id = TurnItemId.make(`turn-item:secret-sent:${run.id}:${host}:${name}`);
                  return projection.turnItems.some((item) => item.id === id)
                    ? []
                    : systemNoticeEvents(
                        projection,
                        run,
                        {
                          id,
                          title: "Secret sent",
                          message: `Sent the secret ${name} to ${host}.`,
                        },
                        ctx,
                      );
                }),
          result: undefined,
        }),
      );
    };

    /** Asks the person to let `names` go to `host` this turn; null when the run can't ask. */
    const ask = (run: OrchestrationV2Run, host: string, names: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const ordinal = (yield* Effect.orDie(withSql(countSecretAsks))) + 1;
        const requestId = askRequestId(run.id, ordinal);
        yield* Effect.orDie(withSql(saveSecretAsk({ requestId, runId: run.id, host, names })));
        const plural = names.length === 1 ? "this secret" : "these secrets";
        return yield* engine.apply((projection, ctx) => {
          const events =
            projection === null
              ? null
              : approvalRequestEvents(
                  projection,
                  run,
                  {
                    requestId,
                    title: "Send a secret?",
                    prompt: `An agent wants to send ${plural} to ${host}: ${listedNames(names)}`,
                    appName: "Secrets",
                    options: askOptions(host),
                  },
                  ctx,
                );
          return Effect.succeed({
            events: events ?? [],
            result: events === null ? null : requestId,
          });
        });
      });

    const decide = (
      host: string,
      names: ReadonlyArray<string>,
    ): Effect.Effect<SendAnswer | { readonly _tag: "asked"; readonly requestId: string }> =>
      Effect.gen(function* () {
        const projection = yield* engine.projection;
        const run = projection === null ? undefined : activeRun(projection);
        if (projection === null || run === undefined) {
          return {
            _tag: "refused",
            message: "No turn is running on this thread, so it doesn't send its secrets anywhere.",
          } as const;
        }
        const owner = (yield* Effect.orDie(store.owner))?.userId ?? null;
        const asks = yield* Effect.orDie(withSql(readSecretAsks({ host })));
        const answer = answersOf(projection);
        let left = new Set(names);
        const declined = new Set<string>();
        for (const candidate of asks) {
          const answered = answer(candidate);
          const thisTurn = candidate.runId === run.id;
          // "Always" counts here only until it's kept in the owner's object, where a revoke ends it.
          if (
            (answered === "accept" && thisTurn) ||
            (answered === "acceptAlways" && candidate.keptAt === null)
          ) {
            for (const name of candidate.names) left.delete(name);
          } else if ((answered === "decline" || answered === "cancel") && thisTurn) {
            for (const name of candidate.names) declined.add(name);
          }
        }
        if (left.size > 0 && owner !== null) {
          const sources = yield* Effect.orDie(withSql(readSecretSources));
          const always = yield* alwaysAllowed(owner, host, [...left], sources);
          left = new Set([...left].filter((name) => !always.has(name)));
        }
        if (left.size === 0) {
          yield* noteSent(run, host, names);
          return { _tag: "allowed" } as const;
        }
        const refusedNow = [...left].filter((name) => declined.has(name));
        if (refusedNow.length > 0) {
          return {
            _tag: "refused",
            message: `The person said no to sending ${listedNames(refusedNow)} to ${host} this turn.`,
          } as const;
        }
        const wanted = [...left].toSorted();
        // Sends made together find the one ask the first of them made.
        const requestId = yield* asking.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* engine.projection;
            const answerNow = current === null ? () => null : answersOf(current);
            const pending = (yield* Effect.orDie(withSql(readSecretAsks({ host })))).findLast(
              (candidate) =>
                candidate.runId === run.id &&
                answerNow(candidate) === "pending" &&
                wanted.every((name) => candidate.names.includes(name)),
            );
            return pending === undefined ? yield* ask(run, host, wanted) : pending.requestId;
          }),
        );
        return requestId === null
          ? ({
              _tag: "refused",
              message: `This turn can't ask the person yet whether ${listedNames(left)} may go to ${host}.`,
            } as const)
          : ({ _tag: "asked", requestId } as const);
      });

    const authorize: ThreadSends["Service"]["authorize"] = ({ host, names, waitMs }) =>
      Effect.gen(function* () {
        const first = yield* decide(host, names);
        if (first._tag !== "asked") return first;
        if (waitMs > 0) {
          let deferred = waiting.get(first.requestId);
          if (deferred === undefined) {
            deferred = yield* Deferred.make<void>();
            waiting.set(first.requestId, deferred);
          }
          // Waits only once it's registered, so an answer that comes meanwhile still wakes it.
          const meanwhile = yield* decide(host, names);
          if (meanwhile._tag !== "asked") return meanwhile;
          yield* Deferred.await(deferred).pipe(Effect.timeoutOption(waitMs));
        }
        const next = yield* decide(host, names);
        return next._tag === "asked"
          ? ({
              _tag: "waiting",
              message: `Waiting for the person to allow sending ${listedNames(names)} to ${host}. They've been asked on the thread; try again once they answer.`,
            } as const)
          : next;
      }).pipe(
        // Ids and counts only, never a host or a secret's name (#285).
        Effect.tap((answer) => Effect.annotateCurrentSpan("secret_send.answer", answer._tag)),
        Effect.withSpan("ThreadSends.authorize", {
          attributes: { "secret_send.count": names.length },
        }),
      );

    const settle: ThreadSends["Service"]["settle"] = Effect.gen(function* () {
      const projection = yield* engine.projection;
      if (projection === null) return;
      const requests = new Map(projection.runtimeRequests.map((request) => [request.id, request]));
      for (const [requestId, deferred] of waiting) {
        if (answerOf(requests.get(RuntimeRequestId.make(requestId))) === "pending") continue;
        yield* Deferred.succeed(deferred, undefined);
        waiting.delete(requestId);
      }
      const answer = answersOf(projection);
      const keep = (yield* Effect.orDie(withSql(readSecretAsks({ unkept: true })))).filter(
        (candidate) => answer(candidate) === "acceptAlways",
      );
      if (keep.length === 0) return;
      const owner = (yield* Effect.orDie(store.owner))?.userId ?? null;
      if (owner === null) return;
      const sources = yield* Effect.orDie(withSql(readSecretSources));
      for (const candidate of keep) {
        const grants = candidate.names.flatMap((name) => {
          const environmentId = sources.get(name);
          return environmentId === undefined ? [] : [{ environmentId, name, host: candidate.host }];
        });
        const kept = yield* users
          .forUser(owner)
          .keepSecretSends(grants)
          .pipe(
            Effect.as(true),
            Effect.catch((error) =>
              Effect.as(
                Effect.logWarning("keeping an always-send answer failed; it's tried again", {
                  reason: error._tag,
                }),
                false,
              ),
            ),
          );
        if (kept) {
          const now = yield* Clock.currentTimeMillis;
          yield* Effect.orDie(withSql(markAskKept(candidate.requestId, now)));
        }
      }
    });

    return ThreadSends.of({ secrets, authorize, settle });
  }),
);
