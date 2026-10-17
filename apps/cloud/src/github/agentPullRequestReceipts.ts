import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as SqlClient from "effect/sql/SqlClient";

import { type AgentPullRequestError, isAgentPullRequestError } from "./agentPullRequestError.ts";
import { parseJson } from "./agentPullRequestOutput.ts";

type ReceiptRow = {
  readonly request_hash: string;
  readonly status: "pending" | "finished";
  readonly result: string | null;
};

type WriteRequest = { readonly operationId: string };

type RefusalCategory = "conflict" | "pending" | "unavailable";
type Refuse = (category: RefusalCategory) => AgentPullRequestError;

// Timeouts and server errors can follow a successful write, so their claims stay pending.
const REFUSED_STATUSES = new Set([400, 401, 403, 404, 409, 413, 415, 422, 429]);

export const makeAgentPullRequestReceipts = (refuse: Refuse) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    yield* sql`CREATE TABLE IF NOT EXISTS agent_pull_request_operations (
      thread_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'finished')),
      result TEXT,
      PRIMARY KEY (thread_id, operation_id)
    )`;

    const hashRequest = (threadId: string, repository: string, request: unknown) =>
      crypto
        .digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify({ threadId, repository, request })),
        )
        .pipe(
          Effect.map(Hex.encode),
          Effect.mapError(() => refuse("unavailable")),
        );

    const lookup = (threadId: string, repository: string, request: WriteRequest) =>
      Effect.gen(function* () {
        const requestHash = yield* hashRequest(threadId, repository, request);
        const [row] = yield* sql<ReceiptRow>`SELECT request_hash, status, result
          FROM agent_pull_request_operations
          WHERE thread_id = ${threadId} AND operation_id = ${request.operationId}`;
        if (row === undefined) return { _tag: "new" } as const;
        if (row.request_hash !== requestHash) return yield* refuse("conflict");
        if (row.status === "pending") return yield* refuse("pending");
        if (row.result === null) return yield* refuse("unavailable");
        const result = parseJson(row.result);
        if (result === null) return yield* refuse("unavailable");
        return { _tag: "replay", result } as const;
      });

    const claim = (threadId: string, operationId: string, requestHash: string) =>
      Effect.gen(function* () {
        const inserted = yield* sql<{
          readonly operation_id: string;
        }>`INSERT INTO agent_pull_request_operations
          (thread_id, operation_id, request_hash, status, result)
          VALUES (${threadId}, ${operationId}, ${requestHash}, 'pending', NULL)
          ON CONFLICT (thread_id, operation_id) DO NOTHING
          RETURNING operation_id`;
        if (inserted.length > 0) return { _tag: "claimed" } as const;
        const [row] = yield* sql<ReceiptRow>`SELECT request_hash, status, result
          FROM agent_pull_request_operations
          WHERE thread_id = ${threadId} AND operation_id = ${operationId}`;
        if (row === undefined) return yield* refuse("unavailable");
        if (row.request_hash !== requestHash) return yield* refuse("conflict");
        if (row.status === "pending") return yield* refuse("pending");
        if (row.result === null) return yield* refuse("unavailable");
        const result = parseJson(row.result);
        if (result === null) return yield* refuse("unavailable");
        return { _tag: "replay", result } as const;
      });

    const finish = (threadId: string, operationId: string, result: unknown) =>
      sql<{ readonly operation_id: string }>`UPDATE agent_pull_request_operations
        SET status = 'finished', result = ${JSON.stringify(result)}
        WHERE thread_id = ${threadId} AND operation_id = ${operationId} AND status = 'pending'
        RETURNING operation_id`.pipe(
        Effect.flatMap((updated) =>
          updated.length === 0 ? Effect.fail(refuse("unavailable")) : Effect.void,
        ),
        Effect.mapError(() => refuse("unavailable")),
      );

    const run = <A, E>(args: {
      readonly threadId: string;
      readonly repository: string;
      readonly operationId: string;
      readonly request: unknown;
      readonly write: () => Effect.Effect<A, E>;
    }) =>
      Effect.gen(function* () {
        const requestHash = yield* hashRequest(args.threadId, args.repository, args.request);
        const receipt = yield* claim(args.threadId, args.operationId, requestHash);
        if (receipt._tag === "replay") return receipt.result;
        // A lost response is ambiguous, so a pending operation id can never write twice.
        const result = yield* args.write().pipe(
          Effect.tapError((error) =>
            isAgentPullRequestError(error) && REFUSED_STATUSES.has(error.status)
              ? sql`DELETE FROM agent_pull_request_operations
                  WHERE thread_id = ${args.threadId} AND operation_id = ${args.operationId}
                    AND request_hash = ${requestHash} AND status = 'pending'`.pipe(Effect.asVoid)
              : Effect.void,
          ),
        );
        yield* finish(args.threadId, args.operationId, result);
        return result;
      });

    return { lookup, run };
  });
