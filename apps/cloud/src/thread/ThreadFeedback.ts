import {
  FeedbackOutcome as FeedbackOutcomeSchema,
  type FeedbackOutcome,
  type FeedbackRequest,
} from "@signalbox/runner-protocol/FeedbackProtocol";
import type { ProviderUploadFeedbackInput } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { Actor, ThreadNotFoundError } from "./ThreadAccess.ts";
import * as ThreadEngine from "./ThreadEngine.ts";
import * as ThreadStore from "./ThreadStore.ts";
import { runnerInstanceFor } from "./providerCatalog.ts";

export class FeedbackTransport extends Context.Service<
  FeedbackTransport,
  {
    readonly upload: (
      generation: number,
      connection: number,
      request: FeedbackRequest,
    ) => Effect.Effect<FeedbackOutcome>;
  }
>()("@signalbox/cloud/thread/ThreadFeedback/FeedbackTransport") {}

export class ThreadFeedback extends Context.Service<
  ThreadFeedback,
  {
    readonly upload: (
      actor: Actor,
      input: ProviderUploadFeedbackInput,
    ) => Effect.Effect<FeedbackOutcome, ThreadNotFoundError>;
  }
>()("@signalbox/cloud/thread/ThreadFeedback") {}

const encodeOutcome = Schema.encodeSync(Schema.fromJsonString(FeedbackOutcomeSchema));
const decodeOutcome = Schema.decodeUnknownSync(Schema.fromJsonString(FeedbackOutcomeSchema));
const unknown: FeedbackOutcome = { _tag: "failed", failure: "outcome_unknown" };

const make = Effect.gen(function* () {
  const engine = yield* ThreadEngine.ThreadEngine;
  const store = yield* ThreadStore.ThreadStore;
  const transport = yield* FeedbackTransport;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  const upload: ThreadFeedback["Service"]["upload"] = (actor, input) =>
    Effect.gen(function* () {
      // Replays are authorized against current membership too, before touching receipts.
      const { projection } = yield* engine.snapshot(actor);
      if (projection.thread.id !== input.threadId) {
        return yield* new ThreadEngine.ThreadNotFoundError();
      }
      const requestId = input.requestId ?? (yield* Effect.orDie(crypto.randomUUIDv4()));
      yield* Effect.orDie(sql`CREATE TABLE IF NOT EXISTS provider_feedback_receipts (
        request_id TEXT PRIMARY KEY,
        provider_thread_id TEXT,
        generation INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        outcome TEXT
      )`);
      const existing = yield* Effect.orDie(sql<{ outcome: string | null }>`
        SELECT outcome FROM provider_feedback_receipts WHERE request_id = ${requestId}
      `);
      if (existing[0] !== undefined) {
        return existing[0].outcome === null ? unknown : decodeOutcome(existing[0].outcome);
      }
      const providerThread =
        projection.providerThreads.find(
          (candidate) => candidate.id === projection.thread.activeProviderThreadId,
        ) ?? projection.providerThreads.at(-1);
      const lease = yield* Effect.orDie(store.machine);
      // Claim before sending. An interrupted request or lost acknowledgement is never retried.
      const claimed = yield* Effect.orDie(sql`
        INSERT INTO provider_feedback_receipts
          (request_id, provider_thread_id, generation, created_at)
        VALUES (${requestId}, ${providerThread?.id ?? null}, ${lease.generation}, ${yield* Clock.currentTimeMillis})
        ON CONFLICT DO NOTHING RETURNING request_id
      `);
      if (claimed.length === 0) return unknown;
      const outcome: FeedbackOutcome =
        providerThread !== undefined && providerThread.driver !== "codex"
          ? { _tag: "failed", failure: "unsupported" }
          : providerThread?.providerSessionId == null ||
              providerThread.nativeThreadRef?.nativeId == null
            ? { _tag: "failed", failure: "session_unavailable" }
            : lease.status !== "connected" || lease.disconnectedAt !== null
              ? { _tag: "failed", failure: "runner_unavailable" }
              : yield* transport.upload(lease.generation, lease.connection ?? 0, {
                  type: "feedback.upload",
                  requestId,
                  providerThread: {
                    ...providerThread,
                    providerInstanceId:
                      runnerInstanceFor(providerThread.providerInstanceId) ??
                      providerThread.providerInstanceId,
                  },
                  ...(input.reason === undefined ? {} : { reason: input.reason }),
                });
      yield* Effect.orDie(sql`
        UPDATE provider_feedback_receipts SET outcome = ${encodeOutcome(outcome)}
        WHERE request_id = ${requestId}
      `);
      return outcome;
    });
  return ThreadFeedback.of({ upload });
});

export const layer = Layer.effect(ThreadFeedback, make);
