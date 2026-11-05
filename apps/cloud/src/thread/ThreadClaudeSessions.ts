import { MAX_APPEND_BYTES, isStreamName } from "@signalbox/runner-protocol/SessionProtocol";
import type { ClaudeTranscriptCapture } from "../harness/ClaudeTranscriptPort.ts";
import { rpcStubOwner } from "../rpc/Resources.ts";
import { HarnessError } from "../harness/Harness.ts";
import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { SessionRows } from "./session/SessionRows.ts";
import { readClaudeTranscriptRows } from "./session/claudeTranscriptRows.ts";

const Entry = Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [
  Schema.Record(Schema.String, Schema.Unknown),
]);
const decodeEntry = Schema.decodeUnknownSync(Schema.fromJsonString(Entry));
const failure = (message: string, cause?: unknown) =>
  new HarnessError({ operation: "export", message, ...(cause === undefined ? {} : { cause }) });

/** Copies the facet's actual JSONL files into the Runner's existing durable session store. */
export const createThreadClaudeSessions = (options: {
  readonly capture: (nativeId: string, signal: AbortSignal) => Promise<ClaudeTranscriptCapture>;
}) =>
  Effect.gen(function* () {
    const sessions = yield* SessionRows;
    const lock = yield* Semaphore.make(1);
    const persist = (thread: Pick<OrchestrationV2ProviderThread, "driver" | "nativeThreadRef">) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const nativeId = thread.nativeThreadRef?.nativeId;
          if (thread.driver !== "claudeAgent" || nativeId == null)
            return yield* failure("The checkpoint does not name a Claude native session.");
          yield* Effect.acquireUseRelease(
            Effect.tryPromise({
              try: (signal) => options.capture(nativeId, signal),
              catch: (cause) => failure("Could not locate the facet's Claude transcripts.", cause),
            }).pipe(Effect.interruptible),
            (capture) =>
              Effect.gen(function* () {
                const byPath = new Map(capture.manifest.map((file) => [file.path, file]));
                for (const file of capture.streams) {
                  if (!isStreamName(file.stream))
                    return yield* failure("Claude transcript name is invalid.");
                  const entry = byPath.get(file.path);
                  if (entry === undefined)
                    return yield* failure("Claude transcript capture is incomplete.");
                  const readSaved = (offset: number) =>
                    sessions
                      .rows(file.stream, offset)
                      .pipe(
                        Effect.mapError((cause) =>
                          failure("Could not read saved Claude transcript.", cause),
                        ),
                      );
                  let saved = yield* readSaved(0);
                  let savedIndex = 0;
                  let offset = 0;
                  let batch: string[] = [];
                  let batchBytes = 0;
                  const flush = Effect.gen(function* () {
                    if (batch.length === 0) return;
                    const expected = offset + batch.length;
                    const result = yield* sessions
                      .append({ stream: file.stream, offset, rows: batch })
                      .pipe(
                        Effect.mapError((cause) =>
                          failure("Could not save Claude transcript.", cause),
                        ),
                      );
                    if (result._tag !== "stored" || result.count !== expected)
                      return yield* failure(
                        "Claude transcript did not commit at its expected position.",
                      );
                    offset = expected;
                    batch = [];
                    batchBytes = 0;
                  });
                  const rows = readClaudeTranscriptRows(entry, capture.source);
                  let count = 0;
                  for (;;) {
                    const next = yield* Effect.tryPromise({
                      try: () => rows.next(),
                      catch: (cause) =>
                        failure("Claude transcript is incomplete or invalid.", cause),
                    });
                    if (next.done) break;
                    const row = next.value;
                    yield* Effect.try({
                      try: () => decodeEntry(row),
                      catch: (cause) =>
                        failure("Claude transcript is incomplete or invalid.", cause),
                    });
                    count++;
                    if (savedIndex === saved.rows.length && saved.more) {
                      saved = yield* readSaved(offset);
                      savedIndex = 0;
                    }
                    if (savedIndex < saved.rows.length) {
                      if (saved.rows[savedIndex++] !== row)
                        return yield* failure(
                          "Claude transcript changed its already saved prefix.",
                        );
                      offset++;
                      continue;
                    }
                    const bytes = new TextEncoder().encode(row).length;
                    if (batch.length > 0 && batchBytes + bytes > MAX_APPEND_BYTES) yield* flush;
                    batch.push(row);
                    batchBytes += bytes;
                    if (batchBytes >= MAX_APPEND_BYTES) yield* flush;
                  }
                  if (count === 0) return yield* failure("Claude transcript is empty.");
                  if (savedIndex !== saved.rows.length || saved.more)
                    return yield* failure("Claude transcript changed its already saved prefix.");
                  yield* flush;
                }
              }),
            (capture) =>
              Effect.promise(async () => {
                using _source = rpcStubOwner(capture.source);
                await capture.source.close();
              }),
          );
        }),
      );
    return { persist };
  });
