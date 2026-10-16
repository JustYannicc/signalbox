import type { NoteReading } from "@t3tools/contracts/signalboxNotes";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  type ModelForwardReply,
  type ModelPoolRoute,
  PoolDirectory,
  type PoolModelApi,
} from "../pool/PoolDirectory.ts";
import { pickModel, type ReadingPrompt, readingOf, replyText, requestFor } from "./noteReading.ts";

/**
 * Reads one note for whoever reads it at its level (#318): asks a small model
 * on the level's pool what the note means. Never fails and never waits more
 * than `TIMEOUT_MS`: anything but a clear answer is no reading, and the note
 * stays a plain note. Spans carry the model and outcome, never the note, the
 * prompt or the answer.
 */

const TIMEOUT_MS = 20_000;

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export interface ReadRequest extends ReadingPrompt {
  /** The pool the note's level runs on, for its owner; null when the level has none. */
  readonly pool: ModelPoolRoute | null;
}

export class NoteReader extends Context.Service<
  NoteReader,
  { readonly read: (request: ReadRequest) => Effect.Effect<Option.Option<NoteReading>> }
>()("@signalbox/cloud/notes/NoteReader") {}

/** Why a read ended without a reading, or what it read. Misses are logged too: cloud exports no spans. */
type Outcome =
  | "no-pool"
  | "no-model"
  | "pool-unavailable"
  | "denied"
  | "failed"
  | `http ${number}`
  | "unreadable"
  | "timeout"
  | NoteReading["_tag"];

/** A read that ended without a reading for a reason other than the model's answer. */
const missed = (value: Outcome, model?: string) =>
  value === "offer" || value === "unclear"
    ? Effect.void
    : Effect.logWarning("a note read gave no reading", {
        outcome: value,
        ...(model === undefined ? {} : { model }),
      });

const readWith =
  (directory: PoolDirectory["Service"], modelsOf: (objectName: string) => PoolModelApi) =>
  (request: ReadRequest) =>
    Effect.gen(function* () {
      const { pool } = request;
      const outcome = (value: Outcome, model?: string) =>
        Effect.annotateCurrentSpan({
          "note.read.outcome": value,
          ...(model === undefined ? {} : { "note.read.model": model }),
        }).pipe(Effect.andThen(missed(value, model)), Effect.as(Option.none<NoteReading>()));
      if (pool === null) return yield* outcome("no-pool");
      const served = yield* directory
        .forPool(pool.objectName)
        .models({ userId: pool.userId })
        .pipe(Effect.option);
      if (Option.isNone(served)) return yield* outcome("pool-unavailable");
      const picked = pickModel(served.value.models);
      if (picked === null) return yield* outcome("no-model");
      const { id: model, family } = picked;
      const call = requestFor(family, model, request);
      const started = yield* Clock.currentTimeMillis;
      const reply = yield* Effect.tryPromise({
        // A read that's replaced or times out cancels its request where the route passes the signal on.
        try: (signal) =>
          modelsOf(pool.objectName).forwardModel(
            { userId: pool.userId },
            call.path,
            new Request(`https://pool.invalid${call.path}`, {
              method: "POST",
              headers: { "content-type": "application/json", ...call.headers },
              body: encodeJson(call.body),
              signal,
            }),
          ),
        catch: () => "failed" as const,
      }).pipe(Effect.orElseSucceed((): ModelForwardReply => ({ _tag: "failed", reason: "" })));
      yield* Effect.annotateCurrentSpan(
        "note.read.latency_ms",
        (yield* Clock.currentTimeMillis) - started,
      );
      if (reply._tag !== "forwarded") return yield* outcome(reply._tag, model);
      if (!reply.response.ok) {
        yield* Effect.promise(() => reply.response.body?.cancel() ?? Promise.resolve());
        return yield* outcome(`http ${reply.response.status}`, model);
      }
      const json = yield* Effect.tryPromise(() => reply.response.json()).pipe(Effect.option);
      const reading = Option.flatMap(
        Option.flatMap(json, (body) => replyText(family, body)),
        (text) => readingOf(request.reader, text),
      );
      if (Option.isNone(reading)) return yield* outcome("unreadable", model);
      yield* outcome(reading.value._tag, model);
      return reading;
    }).pipe(
      Effect.timeoutOption(TIMEOUT_MS),
      Effect.flatMap((read) =>
        Option.isSome(read)
          ? Effect.succeed(read.value)
          : Effect.annotateCurrentSpan("note.read.outcome", "timeout" satisfies Outcome).pipe(
              Effect.andThen(missed("timeout")),
              Effect.as(Option.none<NoteReading>()),
            ),
      ),
      Effect.withSpan("NoteReader.read", {
        attributes: { "note.reader": request.reader },
      }),
    );

/**
 * Asks the level's pool: `PoolDirectory` for what it serves, `modelsOf` for
 * the pool object's model route (`forwardModel`), which checks the user may
 * still use the pool, as a turn's requests are checked.
 */
export const layer = (modelsOf: (objectName: string) => PoolModelApi) =>
  Layer.effect(
    NoteReader,
    Effect.gen(function* () {
      const directory = yield* PoolDirectory;
      return NoteReader.of({ read: readWith(directory, modelsOf) });
    }),
  );

/** Reads with `read`, for tests. */
export const layerTest = (read: (request: ReadRequest) => Option.Option<NoteReading>) =>
  Layer.succeed(NoteReader, NoteReader.of({ read: (request) => Effect.sync(() => read(request)) }));

/** Reads nothing: notes stay plain notes. */
export const layerNone = layerTest(() => Option.none());
