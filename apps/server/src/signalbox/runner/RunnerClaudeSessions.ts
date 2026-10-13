import type {
  SDKMessage,
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_STREAM_PREFIX } from "@signalbox/runner-protocol/SessionProtocol";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import {
  ClaudeAgentSdkQueryRunner,
  type ClaudeAgentSdkQueryRunnerShape,
  layerQueryRunner,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import type { SessionClient } from "./RunnerSessionClient.ts";
import { SessionNotSavedError, type SessionOutbox } from "./RunnerSessionOutbox.ts";

/**
 * Claude Code's session off the machine (#112, #132), through the Agent SDK's
 * own `SessionStore`: the SDK mirrors every transcript line, subagent
 * sidecars included, as the CLI writes it locally ("eager" flush), and loads
 * the stored session back when a query resumes on a new machine.
 *
 * The store is wired in by wrapping upstream's `ClaudeAgentSdkQueryRunner`
 * (`layerSessionQueryRunner`), so the adapter itself is untouched. The
 * wrapper also holds each assistant or user message until its transcript row
 * is durable, because the CLI writes a message's row only after it streams
 * the message (30 to 120 ms later): a message the thread shows as complete is
 * one a new machine resumes with. A `mirror_error` (the SDK gave up on a
 * batch) is reported, and the Runner stops the turn; the batch itself stays
 * in the outbox and keeps being sent. Once saving has stalled, `append`
 * answers the SDK at once instead of waiting: the CLI's end of turn waits on
 * the SDK's mirror, and the turn should stop now, not minutes later.
 *
 * Streams are `claude/<session id>[/<subpath>]`. The SDK's project key is the
 * working directory, which a new machine may not share, so it is left out.
 */

/** Longer than the SDK waits on one `append` (60 s) would only turn a failure into a timeout. */
const APPEND_WAIT_MS = 45_000;
/** How long a message may wait for a row the CLI might never mirror, while nothing is pending. */
const UNMIRRORED_GRACE_MS = 2_000;
/** How long `load` waits for this machine's own unsaved rows before reading the stream. */
const LOAD_DRAIN_MS = 30_000;

/** The transcript entries that carry an SDK message's uuid. */
const TRANSCRIPT_TYPES: ReadonlySet<string> = new Set(["assistant", "user"]);

const claudeStream = (key: SessionKey) =>
  `${CLAUDE_STREAM_PREFIX}${key.sessionId}${key.subpath === undefined ? "" : `/${key.subpath}`}`;

export interface ClaudeSessions {
  readonly store: SessionStore;
  /** Waits until the transcript row of the message `uuid` is durable (see the module comment). */
  readonly durable: (uuid: string) => Effect.Effect<void>;
  /** Called with the SDK's `mirror_error`. */
  readonly mirrorFailed: (error: string) => Effect.Effect<void>;
}

export const makeClaudeSessions = Effect.fn("makeClaudeSessions")(function* (input: {
  readonly client: SessionClient;
  readonly outbox: SessionOutbox;
  readonly onFailure: (message: string) => Effect.Effect<void>;
}) {
  const context = yield* Effect.context<never>();
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseWith(context)(effect);
  /**
   * Each batch the SDK handed over, so its retries of the same batch queue
   * nothing twice. The SDK's mirror retries with the very same array.
   */
  const batches = new WeakMap<
    ReadonlyArray<SessionStoreEntry>,
    { readonly stream: string; readonly position: number }
  >();
  /** Messages whose rows are durable and that `durable` has not asked about yet. */
  const saved = new Set<string>();
  const waiting = new Map<string, Array<Deferred.Deferred<void>>>();

  /** Fails once saving has stalled; the rows stay queued. */
  const stalled = Effect.repeat(input.outbox.stalled, {
    until: (isStalled) => isStalled,
    schedule: Schedule.spaced("200 millis"),
  }).pipe(
    Effect.andThen(
      Effect.fail(new SessionNotSavedError({ message: "Saving the session has stalled." })),
    ),
  );

  const markSaved = (entries: ReadonlyArray<SessionStoreEntry>) =>
    Effect.gen(function* () {
      for (const entry of entries) {
        if (entry.uuid === undefined || !TRANSCRIPT_TYPES.has(entry.type)) continue;
        const waiters = waiting.get(entry.uuid);
        if (waiters === undefined) {
          saved.add(entry.uuid);
          continue;
        }
        waiting.delete(entry.uuid);
        for (const done of waiters) yield* Deferred.succeed(done, undefined);
      }
    });

  const store: SessionStore = {
    append: (key, entries) =>
      run(
        Effect.gen(function* () {
          let batch = batches.get(entries);
          if (batch === undefined) {
            const stream = claudeStream(key);
            const rows = entries.map((entry) => JSON.stringify(entry));
            batch = { stream, position: yield* input.outbox.enqueue(stream, rows) };
            batches.set(entries, batch);
          }
          yield* Effect.raceFirst(
            input.outbox.reach(batch.stream, batch.position, APPEND_WAIT_MS),
            stalled,
          );
          yield* markSaved(entries);
        }),
      ),
    load: (key) =>
      run(
        Effect.gen(function* () {
          const stream = claudeStream(key);
          // This machine's own unsaved rows come first, or the load would miss them.
          yield* input.outbox.settled(stream, LOAD_DRAIN_MS);
          const rows = yield* input.client.rows(stream);
          yield* input.outbox.stored(stream, rows.length);
          return rows.length === 0 ? null : rows.map((row) => JSON.parse(row) as SessionStoreEntry);
        }),
      ),
    listSubkeys: ({ sessionId }) => {
      const sidecars = `${CLAUDE_STREAM_PREFIX}${sessionId}/`;
      return run(
        Effect.map(input.client.streams(sidecars), (streams) =>
          streams.map(({ stream }) => stream.slice(sidecars.length)),
        ),
      );
    },
  };

  const durable: ClaudeSessions["durable"] = (uuid) =>
    Effect.gen(function* () {
      if (saved.delete(uuid)) return;
      const done = yield* Deferred.make<void>();
      waiting.set(uuid, [...(waiting.get(uuid) ?? []), done]);
      const forget = Effect.sync(() => {
        const rest = (waiting.get(uuid) ?? []).filter((other) => other !== done);
        if (rest.length === 0) waiting.delete(uuid);
        else waiting.set(uuid, rest);
      });
      // A row that is never mirrored must not hold the turn forever: after a
      // grace period, go on once nothing is waiting to be saved, or once
      // saving has stalled (the turn is being stopped then).
      const unmirrored = Effect.sleep(UNMIRRORED_GRACE_MS).pipe(
        Effect.andThen(
          Effect.repeat(
            Effect.gen(function* () {
              return !(yield* input.outbox.pending) || (yield* input.outbox.stalled);
            }),
            { until: (settled) => settled, schedule: Schedule.spaced("100 millis") },
          ),
        ),
      );
      yield* Effect.raceFirst(Deferred.await(done), Effect.asVoid(unmirrored)).pipe(
        Effect.ensuring(forget),
      );
    });

  return {
    store,
    durable,
    mirrorFailed: (error) =>
      Effect.logWarning("Claude could not mirror its session", { error }).pipe(
        Effect.andThen(
          input.onFailure("This turn's session could not be saved, so it was stopped."),
        ),
      ),
  } satisfies ClaudeSessions;
});

/** Messages the CLI writes to its transcript under the same uuid. */
const isTranscriptMessage = (message: SDKMessage): message is SDKMessage & { uuid: string } =>
  (message.type === "assistant" || message.type === "user") &&
  typeof message.uuid === "string" &&
  !("isReplay" in message && message.isReplay === true);

/**
 * `inner` with every query mirroring its session into `sessions` and every
 * transcript message held until its row is durable.
 */
export const withSessions = (
  inner: ClaudeAgentSdkQueryRunnerShape,
  sessions: ClaudeSessions,
): ClaudeAgentSdkQueryRunnerShape => ({
  ...inner,
  open: (input) =>
    Effect.map(
      inner.open({
        ...input,
        options: { ...input.options, sessionStore: sessions.store, sessionStoreFlush: "eager" },
      }),
      (session) => ({
        ...session,
        messages: session.messages.pipe(
          Stream.mapEffect((message): Effect.Effect<SDKMessage> =>
            message.type === "system" && message.subtype === "mirror_error"
              ? Effect.as(sessions.mirrorFailed(message.error), message)
              : isTranscriptMessage(message)
                ? Effect.as(sessions.durable(message.uuid), message)
                : Effect.succeed(message),
          ),
        ),
      }),
    ),
});

/** Upstream's query runner, wrapped by `withSessions` and then `wrap`. */
export const layerSessionQueryRunner = (
  sessions: ClaudeSessions,
  wrap: (runner: ClaudeAgentSdkQueryRunnerShape) => ClaudeAgentSdkQueryRunnerShape = (runner) =>
    runner,
) =>
  Layer.effect(
    ClaudeAgentSdkQueryRunner,
    Effect.gen(function* () {
      const inner = yield* ClaudeAgentSdkQueryRunner;
      return ClaudeAgentSdkQueryRunner.of(wrap(withSessions(inner, sessions)));
    }),
  ).pipe(Layer.provide(layerQueryRunner));
