import { AgentBrowserStep } from "@t3tools/contracts/signalboxPreviews";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import type { AttachmentStorage } from "../../attachments/attachmentObjects.ts";

/**
 * The thread's browser trail (#587): every finished step of the agent's
 * browsing, each with the rrweb recording of its page, so the page stays
 * watchable after the machine stops. Recordings live gzipped in the drives
 * bucket beside the thread's attachments, under the deployment's preview
 * prefix, so a preview's go with it; the object's own database indexes them.
 * The table is fork-owned and creates itself (see `SessionRows.ts`).
 *
 * Only the newest `MAX_STEPS` stay; older recordings are deleted as new ones
 * land. Each recording is at most `MAX_STEP_BYTES` before compression.
 */

export const MAX_STEPS = 300;
export const MAX_STEP_BYTES = 16 * 1024 * 1024;

export class BrowserTrailError extends Schema.TaggedError<BrowserTrailError>()(
  "BrowserTrailError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export class BrowserTrail extends Context.Service<
  BrowserTrail,
  {
    /** Keeps `step` with its recording (rrweb events as a JSON array, in pieces). A step kept already stays as it was. */
    readonly store: (
      step: AgentBrowserStep,
      recording: ReadonlyArray<Uint8Array>,
    ) => Effect.Effect<void, BrowserTrailError | SqlError>;
    /** Oldest first. */
    readonly steps: Effect.Effect<ReadonlyArray<AgentBrowserStep>, SqlError>;
    /** Whether the trail holds a step. */
    readonly browsed: Effect.Effect<boolean, SqlError>;
    /** A step's recording as a JSON array; null when the trail no longer holds it. */
    readonly recording: (
      stepId: string,
    ) => Effect.Effect<string | null, BrowserTrailError | SqlError>;
  }
>()("@signalbox/cloud/thread/preview/BrowserTrail") {}

const decodeKeys = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ seq: Schema.Number, object_key: Schema.String })),
);
const StepRows = Schema.Array(Schema.Struct({ step: Schema.fromJsonString(AgentBrowserStep) }));
const decodeSteps = Schema.decodeUnknownSync(StepRows);
const encodeStep = Schema.encodeSync(Schema.fromJsonString(AgentBrowserStep));

const bucket = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new BrowserTrailError({ operation, cause }) });

const gzip = (recording: ReadonlyArray<Uint8Array>) =>
  bucket("compress", async () => {
    const compressed = new Blob(recording as Array<Uint8Array<ArrayBuffer>>)
      .stream()
      .pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(compressed).arrayBuffer());
  });

export const layer = (storage: AttachmentStorage, threadId: () => string) =>
  Layer.effect(
    BrowserTrail,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const crypto = yield* Crypto.Crypto;
      const { objects, prefix } = storage;

      let ready = false;
      const table = Effect.suspend(() =>
        ready
          ? Effect.void
          : Effect.gen(function* () {
              yield* sql`CREATE TABLE IF NOT EXISTS browser_trail (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                step_id TEXT NOT NULL UNIQUE,
                step TEXT NOT NULL,
                object_key TEXT NOT NULL
              )`;
              ready = true;
            }),
      );

      /** Deletes recordings past the newest `MAX_STEPS`, objects first, so none is left behind unlisted. */
      const evict = Effect.gen(function* () {
        const old = decodeKeys(
          yield* sql`SELECT seq, object_key FROM browser_trail
            WHERE seq <= (SELECT seq FROM browser_trail ORDER BY seq DESC LIMIT 1 OFFSET ${MAX_STEPS})`,
        );
        if (old.length === 0) return;
        yield* bucket("delete", () => objects.delete(old.map((row) => row.object_key)));
        const last = Math.max(...old.map((row) => row.seq));
        yield* sql`DELETE FROM browser_trail WHERE seq <= ${last}`;
      });

      const store: BrowserTrail["Service"]["store"] = (step, recording) =>
        Effect.gen(function* () {
          yield* table;
          const size = recording.reduce((sum, piece) => sum + piece.byteLength, 0);
          if (size > MAX_STEP_BYTES) {
            return yield* new BrowserTrailError({
              operation: "store",
              cause: `The recording is ${size} bytes.`,
            });
          }
          const existing = yield* sql`SELECT 1 FROM browser_trail WHERE step_id = ${step.stepId}`;
          if (existing.length > 0) return;
          const key = `${prefix}browser-trail/${encodeURIComponent(threadId())}/${yield* Effect.orDie(crypto.randomUUIDv4())}.json.gz`;
          const body = yield* gzip(recording);
          yield* bucket("put", () =>
            objects.put(key, body, {
              customMetadata: { thread: threadId(), type: "browser-step" },
            }),
          );
          yield* sql`INSERT INTO browser_trail (step_id, step, object_key)
            VALUES (${step.stepId}, ${encodeStep(step)}, ${key})`.pipe(
            Effect.onError(() => bucket("delete", () => objects.delete(key)).pipe(Effect.ignore)),
          );
          yield* evict;
        });

      const steps: BrowserTrail["Service"]["steps"] = Effect.gen(function* () {
        yield* table;
        const rows = decodeSteps(yield* sql`SELECT step FROM browser_trail ORDER BY seq`);
        return rows.map((row) => row.step);
      });

      const browsed: BrowserTrail["Service"]["browsed"] = Effect.gen(function* () {
        yield* table;
        const rows = yield* sql`SELECT 1 FROM browser_trail LIMIT 1`;
        return rows.length > 0;
      });

      const recording: BrowserTrail["Service"]["recording"] = (stepId) =>
        Effect.gen(function* () {
          yield* table;
          const [row] = decodeKeys(
            yield* sql`SELECT seq, object_key FROM browser_trail WHERE step_id = ${stepId}`,
          );
          if (row === undefined) return null;
          const object = yield* bucket("get", () => objects.get(row.object_key));
          if (object === null) return null;
          return yield* bucket("decompress", () =>
            new Response(
              (object.body as ReadableStream<Uint8Array<ArrayBuffer>>).pipeThrough(
                new DecompressionStream("gzip"),
              ),
            ).text(),
          );
        });

      return BrowserTrail.of({ store, steps, browsed, recording });
    }),
  );
