import { CLAUDE_STREAM_PREFIX, isStreamName } from "@signalbox/runner-protocol/SessionProtocol";
import type { Computer } from "../computer/Computer.ts";
import { createNodeFs } from "../isolate/NodeFs.ts";
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
  readonly files: Computer["files"];
  readonly configurationDirectory: string;
}) =>
  Effect.gen(function* () {
    const sessions = yield* SessionRows;
    const lock = yield* Semaphore.make(1);
    const fs = createNodeFs(options.files).fs;
    const projects = `${options.configurationDirectory.replace(/\/$/, "")}/projects`;
    const statIfPresent = async (path: string, signal: AbortSignal) => {
      try {
        return await options.files.statAsync(path, signal);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return undefined;
        throw error;
      }
    };
    const filesFor = async (nativeId: string, signal: AbortSignal) => {
      if (!/^[a-zA-Z0-9-]+$/.test(nativeId)) throw failure("Claude native session id is invalid.");
      const matches: string[] = [];
      if (await statIfPresent(projects, signal)) {
        const entries = await options.files.readdirAsync(projects, signal);
        for (const entry of entries) {
          const directory = `${projects}/${String(entry)}`;
          const path = `${directory}/${nativeId}.jsonl`;
          const directoryStat = await options.files.statAsync(directory, signal);
          const fileStat =
            directoryStat.type === "directory" ? await statIfPresent(path, signal) : undefined;
          if (directoryStat.type === "directory" && fileStat) matches.push(path);
        }
      }
      if (matches.length !== 1)
        throw failure("Claude's native transcript is missing or ambiguous.");
      const main = matches[0]!;
      const result = [{ stream: `${CLAUDE_STREAM_PREFIX}${nativeId}`, path: main }];
      const sidecars = main.slice(0, -".jsonl".length);
      const visit = async (directory: string, relative: string) => {
        for (const entry of await options.files.readdirAsync(directory, signal)) {
          const name = String(entry);
          const path = `${directory}/${name}`;
          const subpath = relative === "" ? name : `${relative}/${name}`;
          const stat = await options.files.lstatAsync(path, signal);
          if (stat.type === "directory") await visit(path, subpath);
          else if (stat.type === "file" && name.endsWith(".jsonl"))
            result.push({ stream: `${CLAUDE_STREAM_PREFIX}${nativeId}/${subpath}`, path });
        }
      };
      if (await statIfPresent(sidecars, signal)) await visit(sidecars, "");
      return result;
    };
    const persist = (thread: Pick<OrchestrationV2ProviderThread, "driver" | "nativeThreadRef">) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const nativeId = thread.nativeThreadRef?.nativeId;
          if (thread.driver !== "claudeAgent" || nativeId == null)
            return yield* failure("The checkpoint does not name a Claude native session.");
          const files = yield* Effect.tryPromise({
            try: (signal) => filesFor(nativeId, signal),
            catch: (cause) => failure("Could not locate the facet's Claude transcripts.", cause),
          });
          for (const file of files) {
            const rows = yield* Effect.try({
              try: () => {
                if (!isStreamName(file.stream)) throw failure("Claude transcript name is invalid.");
                const text = String(fs.readFileSync(file.path, "utf8"));
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
