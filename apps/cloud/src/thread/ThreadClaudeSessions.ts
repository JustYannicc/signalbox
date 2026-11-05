import { isStreamName } from "@signalbox/runner-protocol/SessionProtocol";
import type { ClaudeTranscriptCapture } from "../harness/ClaudeTranscriptPort.ts";
import { readKernelFileTransfer } from "../kernel/KernelFileTransfer.ts";
import { HarnessError } from "../harness/Harness.ts";
import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { SessionRows } from "./session/SessionRows.ts";

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
          const captured = yield* Effect.tryPromise({
            try: async (signal) => {
              const capture = await options.capture(nativeId, signal);
              const files = await readKernelFileTransfer(capture.manifest, capture.source, signal);
              const byPath = new Map(files.map((file) => [file.path, file.bytes]));
              return capture.streams.map(({ stream, path }) => {
                const bytes = byPath.get(path);
                if (bytes === undefined) throw failure("Claude transcript capture is incomplete.");
                return { stream, bytes };
              });
            },
            catch: (cause) => failure("Could not locate the facet's Claude transcripts.", cause),
          });
          for (const file of captured) {
            const rows = yield* Effect.try({
              try: () => {
                if (!isStreamName(file.stream)) throw failure("Claude transcript name is invalid.");
                const text = new TextDecoder().decode(file.bytes);
                const lines = text.split("\n");
                if (lines.at(-1) === "") lines.pop();
                if (lines.length === 0) throw failure("Claude transcript is empty.");
                for (const line of lines) decodeEntry(line);
                return lines;
              },
              catch: (cause) => failure("Claude transcript is incomplete or invalid.", cause),
            });
            let offset = 0;
            for (;;) {
              const stored = yield* sessions
                .rows(file.stream, offset)
                .pipe(
                  Effect.mapError((cause) =>
                    failure("Could not read saved Claude transcript.", cause),
                  ),
                );
              if (stored.rows.some((row, index) => row !== rows[offset + index]))
                return yield* failure("Claude transcript changed its already saved prefix.");
              offset += stored.rows.length;
              if (!stored.more) break;
            }
            const result = yield* sessions
              .append({
                stream: file.stream,
                offset,
                rows: rows.slice(offset),
              })
              .pipe(
                Effect.mapError((cause) => failure("Could not save Claude transcript.", cause)),
              );
            if (result._tag !== "stored" || result.count !== rows.length)
              return yield* failure("Claude transcript did not commit at its expected position.");
          }
        }),
      );
    return { persist };
  });
