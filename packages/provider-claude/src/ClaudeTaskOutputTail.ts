import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/**
 * Live output for a foreground Claude Bash call.
 *
 * The Agent SDK sends no stdout until the tool result. Claude Code does write
 * each running command's combined output to
 * `<tmp>/claude-<uid>/<project>/<session_id>/tasks/<task_id>.output`, naming
 * the task in its `task_started` frame (`task_type: "local_bash"`). This path is
 * Claude Code's private layout, not SDK API, so every step degrades to "no live
 * output". The inline tool result may be clipped; its `persistedOutputPath`
 * names the full output, which must be drained before the call settles.
 */

/** How often the file is checked while its command runs. */
const CLAUDE_TASK_OUTPUT_POLL_MS = 250;
/** Give up looking for a file Claude Code never wrote (a newer layout, or Windows). */
const MAX_LOCATE_ATTEMPTS = 40;
/** Bytes read per poll. A faster writer skips ahead: only the tail is shown anyway. */
const MAX_READ_BYTES = 256 * 1024;

const locate = Effect.fn("ClaudeTaskOutputTail.locate")(function* (input: {
  readonly root: string;
  readonly sessionId: string;
  readonly taskId: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* fileSystem.readDirectory(input.root).pipe(Effect.orElseSucceed(() => []));
  for (const project of projects) {
    const candidate = path.join(
      input.root,
      project,
      input.sessionId,
      "tasks",
      `${input.taskId}.output`,
    );
    if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
      return Option.some(candidate);
    }
  }
  return Option.none<string>();
});

const readAt = Effect.fn("ClaudeTaskOutputTail.readAt")(function* (
  filePath: string,
  start: number,
  length: number,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fileSystem.open(filePath, { flag: "r" });
      yield* handle.seek(BigInt(start), "start");
      const bytes = new Uint8Array(length);
      let read = 0;
      while (read < length) {
        const chunk = yield* handle.readAlloc(length - read);
        if (Option.isNone(chunk) || chunk.value.length === 0) break;
        bytes.set(chunk.value, read);
        read += chunk.value.length;
      }
      return read === 0 ? Option.none<Uint8Array>() : Option.some(bytes.subarray(0, read));
    }),
  ).pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
});

const tailOutput = Effect.fn("ClaudeTaskOutputTail.tail")(function* (input: {
  readonly locate: Effect.Effect<Option.Option<string>, never, FileSystem.FileSystem | Path.Path>;
  readonly stop: Deferred.Deferred<string | undefined>;
  readonly onChunk: (chunk: string) => Effect.Effect<void>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  // True once stopped: the next read is the last.
  const pause = Effect.raceFirst(
    Effect.sleep(CLAUDE_TASK_OUTPUT_POLL_MS).pipe(Effect.as(false)),
    Deferred.await(input.stop).pipe(Effect.as(true)),
  );
  let file = Option.none<string>();
  for (let attempt = 0; Option.isNone(file); attempt += 1) {
    if (yield* Deferred.isDone(input.stop)) break;
    file = yield* input.locate;
    if (Option.isSome(file)) break;
    if (attempt + 1 >= MAX_LOCATE_ATTEMPTS || (yield* pause)) break;
  }
  if (Option.isNone(file)) {
    const persistedOutputPath = yield* Deferred.await(input.stop);
    file =
      persistedOutputPath === undefined ? yield* input.locate : Option.some(persistedOutputPath);
    if (Option.isNone(file)) return;
  }
  let filePath = file.value;
  // `stream: true` keeps a multi-byte character split across reads intact;
  // invalid bytes become U+FFFD.
  let decoder = new TextDecoder("utf-8", { fatal: false });
  let offset = 0;
  let prefix: Uint8Array | undefined = new Uint8Array();
  let last = yield* Deferred.isDone(input.stop);
  while (true) {
    if (last) {
      const persistedOutputPath = yield* Deferred.await(input.stop);
      if (persistedOutputPath !== undefined && persistedOutputPath !== filePath) {
        // Continue only after comparing the entire captured byte prefix. A
        // prefix beyond our IO budget cannot prove identity, so leave it alone.
        const previous =
          offset === 0
            ? Option.some(new Uint8Array())
            : prefix !== undefined && prefix.length === offset
              ? yield* readAt(persistedOutputPath, 0, offset)
              : Option.none<Uint8Array>();
        if (
          Option.isSome(previous) &&
          previous.value.length === offset &&
          prefix?.every((byte, index) => previous.value[index] === byte)
        ) {
          filePath = persistedOutputPath;
        }
      }
    }
    const size = yield* fileSystem.stat(filePath).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => offset),
    );
    if (size < offset) {
      // A persisted file shorter than the live cursor must not replay old bytes.
      if (last) return;
      offset = 0;
      prefix = undefined;
      decoder = new TextDecoder("utf-8", { fatal: false });
    }
    if (size > offset) {
      const start = size - offset > MAX_READ_BYTES ? size - MAX_READ_BYTES : offset;
      const bytes = yield* readAt(filePath, start, size - start);
      if (Option.isSome(bytes)) {
        // Skipped output must not splice two unrelated lines together.
        const skipped = start > offset;
        // Bytes held from before the gap belong to a character we never finished reading.
        if (skipped) decoder = new TextDecoder("utf-8", { fatal: false });
        offset = start + bytes.value.byteLength;
        if (prefix !== undefined && start === prefix.length && offset <= MAX_READ_BYTES) {
          const nextPrefix = new Uint8Array(offset);
          nextPrefix.set(prefix);
          nextPrefix.set(bytes.value, start);
          prefix = nextPrefix;
        } else {
          prefix = undefined;
        }
        const text = (skipped ? "\n" : "") + decoder.decode(bytes.value, { stream: true });
        if (text.length > 0) yield* input.onChunk(text);
      }
    }
    if (last) {
      // A command that ended mid-character still shows a replacement character.
      const rest = decoder.decode();
      if (rest.length > 0) yield* input.onChunk(rest);
      return;
    }
    last = yield* pause;
  }
});

/** Stop with the SDK's persisted full-output path, or undefined on turn teardown. */
export const tailClaudeTaskOutput = (input: {
  readonly root: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly stop: Deferred.Deferred<string | undefined>;
  readonly onChunk: (chunk: string) => Effect.Effect<void>;
}) => tailOutput({ ...input, locate: locate(input) });

/** A command can settle before Claude emits a foreground task_started frame. */
export const drainClaudePersistedOutput = Effect.fn("ClaudeTaskOutputTail.drainPersisted")(
  function* (input: {
    readonly path: string;
    readonly onChunk: (chunk: string) => Effect.Effect<void>;
  }) {
    const stop = yield* Deferred.make<string | undefined>();
    yield* Deferred.succeed(stop, input.path);
    yield* tailOutput({ locate: Effect.succeed(Option.none()), stop, onChunk: input.onChunk });
  },
);
