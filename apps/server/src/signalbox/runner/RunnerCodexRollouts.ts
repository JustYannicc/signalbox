import { CODEX_STREAM_PREFIX } from "@signalbox/runner-protocol/SessionProtocol";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import type { SessionClient, SessionClientError } from "./RunnerSessionClient.ts";
import { SessionNotSavedError, type SessionOutbox } from "./RunnerSessionOutbox.ts";

/**
 * Codex's session off the machine (#112, #132): its rollout files under
 * `CODEX_HOME/sessions`, one stream per file (`codex/<path under sessions>`).
 * Each file is tailed from a byte cursor; only complete lines are sent, as
 * written. Subagents write rollouts of their own, so every file is tailed.
 *
 * `restore` runs before Codex resumes a thread: a file the store holds more
 * of than this disk (a new machine) is written back from the store, where
 * `thread/resume` finds it by thread id. Tailing starts then, knowing what
 * the store holds, so it never waits on the network. `settle` sends whatever
 * was written since the last look and waits until it is durable; the Runner
 * calls it before it reports anything complete, since Codex writes a row
 * moments after the event that announces it.
 */

/** How often the files are looked at between settles. */
const POLL_MS = 250;
/** Lets Codex's rollout writer flush the row for an event it just sent. */
const WRITE_SETTLE_MS = 25;
const NEWLINE = 0x0a;

export interface CodexRollouts {
  readonly restore: Effect.Effect<void, SessionClientError | PlatformError.PlatformError>;
  readonly settle: (waitMs: number) => Effect.Effect<void, SessionNotSavedError>;
}

/** A stream name as a path under the sessions directory, or null when it is not a safe one. */
const relativePathOf = (stream: string) => {
  if (!stream.startsWith(CODEX_STREAM_PREFIX)) return null;
  const relative = stream.slice(CODEX_STREAM_PREFIX.length);
  return relative
    .split("/")
    .every((segment) => /^[A-Za-z0-9._-]+$/.test(segment) && !/^\.+$/.test(segment))
    ? relative
    : null;
};

/** The complete lines in `bytes`, and how many bytes they take. */
const completeLines = (bytes: Uint8Array) => {
  const end = bytes.lastIndexOf(NEWLINE) + 1;
  if (end === 0) return { lines: [] as Array<string>, length: 0 };
  const text = new TextDecoder().decode(bytes.subarray(0, end));
  return { lines: text.slice(0, -1).split("\n"), length: end };
};

/** Bytes taken by the first `count` lines of `bytes`, or null when it holds fewer. */
const lengthOfLines = (bytes: Uint8Array, count: number) => {
  let end = 0;
  for (let line = 0; line < count; line++) {
    const next = bytes.indexOf(NEWLINE, end);
    if (next === -1) return null;
    end = next + 1;
  }
  return end;
};

export const makeCodexRollouts = Effect.fn("makeCodexRollouts")(function* (input: {
  readonly codexHome: string;
  readonly client: SessionClient;
  readonly outbox: SessionOutbox;
}): Effect.fn.Return<CodexRollouts, never, FileSystem.FileSystem | Path.Path | Scope.Scope> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  const sessionsDir = path.join(input.codexHome, "sessions");
  /** Bytes of each file already queued, by stream. */
  const cursors = new Map<string, number>();
  /** Streams the store held at the last restore; null until then, and nothing is tailed. */
  let listed: ReadonlySet<string> | null = null;
  let polling = false;
  const lock = yield* Semaphore.make(1);

  /** Starts a file's cursor after the rows the store already holds of it. */
  const startCursor = (stream: string, file: string) =>
    Effect.gen(function* () {
      // Born on this machine since the restore: the store holds none of it.
      if (listed !== null && !listed.has(stream)) yield* input.outbox.stored(stream, 0);
      const held = yield* input.outbox.count(stream);
      const length = lengthOfLines(yield* fs.readFile(file), held);
      // The store holds more than this disk: only a restore puts that right.
      if (length === null) return false;
      cursors.set(stream, length);
      return true;
    });

  /** Queues the complete lines written to `relative` since its cursor. */
  const tail = (relative: string) =>
    Effect.gen(function* () {
      const stream = `${CODEX_STREAM_PREFIX}${relative}`;
      const file = path.join(sessionsDir, relative);
      if (!cursors.has(stream) && !(yield* startCursor(stream, file))) return;
      const from = cursors.get(stream) ?? 0;
      const size = Number((yield* fs.stat(file)).size);
      if (size <= from) return;
      const bytes = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* fs.open(file, { flag: "r" });
          yield* handle.seek(BigInt(from), "start");
          return Option.getOrElse(yield* handle.readAlloc(size - from), () => new Uint8Array());
        }),
      );
      const { lines, length } = completeLines(bytes);
      if (lines.length === 0) return;
      cursors.set(stream, from + length);
      yield* input.outbox.enqueue(stream, lines);
    });

  const scan = lock
    .withPermits(1)(
      Effect.gen(function* () {
        if (listed === null || !(yield* fs.exists(sessionsDir))) return;
        for (const relative of yield* fs.readDirectory(sessionsDir, { recursive: true })) {
          if (relative.endsWith(".jsonl") && relativePathOf(`${CODEX_STREAM_PREFIX}${relative}`)) {
            yield* tail(relative);
          }
        }
      }),
    )
    .pipe(Effect.catchCause((cause) => Effect.logWarning("reading Codex rollouts failed", cause)));

  // Between settles, rows still leave as they are written: once tailing can start.
  const poll = Effect.suspend(() => {
    if (polling) return Effect.void;
    polling = true;
    return Effect.asVoid(scan.pipe(Effect.repeat(Schedule.spaced(POLL_MS)), Effect.forkIn(scope)));
  });

  const restore: CodexRollouts["restore"] = lock
    .withPermits(1)(
      Effect.gen(function* () {
        const stored = yield* input.client.streams(CODEX_STREAM_PREFIX);
        for (const { stream, count } of stored) {
          const relative = relativePathOf(stream);
          if (relative === null) {
            yield* Effect.logWarning("skipping a stored rollout with an unsafe name", { stream });
            continue;
          }
          const file = path.join(sessionsDir, relative);
          yield* input.outbox.stored(stream, count);
          // This disk holds as much or more: the rest is queued from the cursor.
          if ((yield* fs.exists(file)) && (yield* startCursor(stream, file))) continue;
          const rows = yield* input.client.rows(stream);
          const body = new TextEncoder().encode(rows.map((row) => `${row}\n`).join(""));
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          yield* fs.writeFile(`${file}.restore`, body);
          yield* fs.rename(`${file}.restore`, file);
          cursors.set(stream, body.byteLength);
        }
        listed = new Set(stored.map(({ stream }) => stream));
      }),
    )
    .pipe(Effect.andThen(poll));

  return {
    restore,
    settle: (waitMs) =>
      Effect.sleep(WRITE_SETTLE_MS).pipe(
        Effect.andThen(scan),
        Effect.andThen(input.outbox.drain(waitMs)),
        Effect.timeoutOrElse({
          duration: waitMs,
          orElse: () =>
            Effect.fail(
              new SessionNotSavedError({ message: "Codex's rollout was not saved in time." }),
            ),
        }),
      ),
  } satisfies CodexRollouts;
});
