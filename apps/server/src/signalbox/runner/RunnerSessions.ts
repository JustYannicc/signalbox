import type { SessionAccess } from "@signalbox/runner-protocol/SessionProtocol";
import type { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { HttpClient } from "effect/http";

import { CODEX_DRIVER_KIND } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import type { ProviderAdapterV2Event } from "../../orchestration-v2/ProviderAdapter.ts";
import { type ClaudeSessions, makeClaudeSessions } from "./RunnerClaudeSessions.ts";
import { makeCodexRollouts } from "./RunnerCodexRollouts.ts";
import { makeSessionClient } from "./RunnerSessionClient.ts";
import { makeSessionOutbox } from "./RunnerSessionOutbox.ts";

/**
 * A machine's harness sessions, kept off the machine (#112, #132): Claude
 * Code's through the Agent SDK's session store (`RunnerClaudeSessions.ts`),
 * Codex's by tailing its rollouts (`RunnerCodexRollouts.ts`), both through
 * one outbox to the thread (`RunnerSessionOutbox.ts`). What a turn needs:
 *
 * - `use` points the store at the turn's session token.
 * - `prepare`, before the harness loads its session: rows this machine still
 *   holds are saved, and a Codex session the store holds more of than this
 *   disk is written back, so a native resume picks up at the latest durable row.
 * - `settle`, before an event that reports something complete goes out: its
 *   rows are durable first. Claude's messages already wait in the SDK stream.
 * - `failures`: saving stalled. The Runner stops the turn; rows keep going.
 */

export class RunnerSessionError extends Schema.TaggedError<RunnerSessionError>()(
  "RunnerSessionError",
  { message: Schema.String },
) {}

export interface RunnerSessions {
  readonly use: (access: SessionAccess) => Effect.Effect<void>;
  readonly prepare: (driver: ProviderDriverKind) => Effect.Effect<void, RunnerSessionError>;
  readonly settle: (
    driver: ProviderDriverKind,
    event: ProviderAdapterV2Event,
  ) => Effect.Effect<void>;
  readonly failures: Queue.Dequeue<string>;
  readonly claude: ClaudeSessions;
}

/** Sending that makes no progress for this long stops the turn. */
const STALL_AFTER_MS = 30_000;
/** How long a turn start waits for the last turn's unsaved rows. */
const PREPARE_WAIT_MS = 30_000;
/** How long a completion waits for its rows before going out anyway; a stall stops the turn by then. */
const SETTLE_WAIT_MS = STALL_AFTER_MS;

/** Events that say something finished: those wait until the rows behind them are durable. */
const reportsCompletion = (event: ProviderAdapterV2Event) => {
  switch (event.type) {
    case "turn.terminal":
      return true;
    case "turn_item.updated":
      return event.turnItem.status !== "running" && event.turnItem.status !== "pending";
    case "message.updated":
      return !event.message.streaming;
    default:
      return false;
  }
};

export const makeRunnerSessions = Effect.fn("makeRunnerSessions")(function* (input: {
  readonly cloudUrl: string;
  readonly codexHome: string;
}): Effect.fn.Return<
  RunnerSessions,
  never,
  HttpClient.HttpClient | FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  const token = yield* Ref.make<string | null>(null);
  const client = yield* makeSessionClient({ cloudUrl: input.cloudUrl, token: Ref.get(token) });
  const failures = yield* Queue.unbounded<string>();
  const report = (message: string) => Effect.asVoid(Queue.offer(failures, message));
  const outbox = yield* makeSessionOutbox({
    client,
    stallAfterMs: STALL_AFTER_MS,
    onFailure: report,
  });
  const claude = yield* makeClaudeSessions({ client, outbox, onFailure: report });
  const codex = yield* makeCodexRollouts({ codexHome: input.codexHome, client, outbox });

  const notSaved = (cause: { readonly message: string }) =>
    new RunnerSessionError({ message: `The session could not be restored: ${cause.message}` });

  return {
    use: (access) => Ref.set(token, access.token),
    prepare: (driver) =>
      Effect.gen(function* () {
        yield* outbox.drain(PREPARE_WAIT_MS);
        if (driver === CODEX_DRIVER_KIND) yield* codex.restore;
      }).pipe(Effect.mapError(notSaved)),
    settle: (driver, event) =>
      driver === CODEX_DRIVER_KIND && reportsCompletion(event)
        ? // Once saving has stalled the turn is being stopped; waiting would only hold that up.
          Effect.flatMap(outbox.stalled, (stalled) =>
            stalled ? Effect.void : codex.settle(SETTLE_WAIT_MS),
          ).pipe(
            Effect.catchTags({
              SessionNotSavedError: (error) =>
                Effect.logWarning("reporting before the session is saved", error.message),
            }),
          )
        : Effect.void,
    failures,
    claude,
  } satisfies RunnerSessions;
});
