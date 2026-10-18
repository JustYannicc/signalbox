import { secretsJson } from "@signalbox/runner-protocol/SecretsProtocol";
import {
  SESSION_API_PREFIX,
  SESSION_PATHS,
  isStreamName,
  sessionJson,
} from "@signalbox/runner-protocol/SessionProtocol";
import { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ThreadRunner } from "../runner/ThreadRunner.ts";
import { type ThreadObjectNamespace, threadObjectStub } from "../ThreadDirectory.ts";
import { ThreadStore } from "../ThreadStore.ts";
import { ThreadSecretRequests } from "../secrets/ThreadSecretRequests.ts";
import { isSecretRequestPath, serveSecretRequest } from "../secrets/secretRequestRoutes.ts";
import { SessionRows } from "./SessionRows.ts";
import { threadOfSessionToken } from "./sessionToken.ts";

/**
 * The session API a thread's Runner calls (`SessionProtocol.ts`). The Worker
 * routes each request to the thread its token names; the thread's object
 * checks the token against its machine lease and serves the rows from its own
 * database. A write lands only while the token's generation still holds the
 * lease, checked in the same transaction as the write.
 */

export const isSessionApiPath = (pathname: string) => pathname.startsWith(`${SESSION_API_PREFIX}/`);

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

/** The bearer token a Runner's request carries, or "". */
export const bearer = (request: Request) => {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
};

/** Worker side: hands the request to the thread object its token names. */
export function forwardSessionRequest(
  threads: ThreadObjectNamespace,
  request: Request,
  options: { readonly localWorkerd: boolean },
): Promise<Response> | Response {
  const name = threadOfSessionToken(bearer(request));
  const threadId = name === null ? null : decodeThreadId(name);
  if (threadId === null || threadId._tag === "None") {
    return new Response("Not a session token.", { status: 401 });
  }
  return threadObjectStub(threads, threadId.value, options).fetch(request);
}

/** Null for anything unreadable, so no error ever carries what the body held (a secret's value). */
const decodeOrNull =
  <A>(decode: (body: string) => A) =>
  (body: string) => {
    try {
      return decode(body);
    } catch {
      return null;
    }
  };
const decodeAppend = decodeOrNull(sessionJson.append.decode);
const decodeRegistration = decodeOrNull(secretsJson.registrationRequest.decode);

type SessionServices =
  | ThreadRunner
  | ThreadStore
  | SessionRows
  | SqlClient.SqlClient
  | ThreadSecretRequests;

/** One session API call, as the thread object received it. */
export interface SessionRequest {
  readonly method: string;
  readonly url: string;
  readonly token: string;
  readonly body: string;
}

/** Thread object side: one session API request, answered from the object's own database. */
export async function handleSessionRequest(
  request: Request,
  run: <A>(effect: Effect.Effect<A, never, SessionServices>) => Promise<A>,
): Promise<Response> {
  const answer = await run(
    serveSessionRequest({
      method: request.method,
      url: request.url,
      token: bearer(request),
      body: request.method === "POST" ? await request.text() : "",
    }),
  );
  return new Response(answer.body, {
    status: answer.status,
    headers: answer.json ? { "content-type": "application/json" } : {},
  });
}

const text = (body: string, status: number) => ({ status, body, json: false });
const json = (body: string) => ({ status: 200, body, json: true });

export const serveSessionRequest = (input: SessionRequest) =>
  Effect.gen(function* () {
    const { pathname, searchParams } = new URL(input.url);
    if (input.method === "POST" && pathname === SESSION_PATHS.secrets) {
      const registration = decodeRegistration(input.body);
      if (registration === null) return text("Unreadable request.", 400);
      const answer = yield* ThreadRunner.use((runner) =>
        runner.registerSecrets(input.token, registration),
      );
      switch (answer._tag) {
        case "registered":
          return json(secretsJson.registrationResult.encode({ warnings: answer.warnings }));
        case "denied":
          return text(
            answer.reason === "capability"
              ? "This Runner requires run-scoped secret registration."
              : "A newer machine or turn replaced this one.",
            403,
          );
        case "unavailable":
          return text("The session store is unavailable right now.", 500);
      }
    }
    const verdict = yield* ThreadRunner.use((runner) => runner.authorizeSession(input.token));
    if (verdict._tag === "denied") return text(verdict.reason, 403);
    if (input.method === "POST" && isSecretRequestPath(pathname))
      return yield* serveSecretRequest(verdict.generation, input.body);
    const rows = yield* SessionRows;
    if (input.method === "POST" && pathname === SESSION_PATHS.append) {
      const append = decodeAppend(input.body);
      if (append === null) return text("Unreadable request.", 400);
      const sql = yield* SqlClient.SqlClient;
      const written = yield* Effect.gen(function* () {
        // A newer machine took the lease after the token was checked.
        const lease = yield* (yield* ThreadStore).machine;
        if (lease.status === "none" || lease.generation !== verdict.generation) return null;
        return yield* rows.append(append);
      }).pipe(sql.withTransaction);
      return written === null
        ? text("A newer machine replaced this one.", 403)
        : json(sessionJson.appendResult.encode(written));
    }
    if (input.method === "GET" && pathname === SESSION_PATHS.streams) {
      const streams = yield* rows.streams(searchParams.get("prefix") ?? "");
      return json(sessionJson.streams.encode({ streams }));
    }
    if (input.method === "GET" && pathname === SESSION_PATHS.rows) {
      const stream = searchParams.get("stream") ?? "";
      const from = Number(searchParams.get("from") ?? 0);
      if (!isStreamName(stream) || !Number.isSafeInteger(from) || from < 0) {
        return text("Unknown stream or row.", 400);
      }
      return json(sessionJson.rows.encode(yield* rows.rows(stream, from)));
    }
    return text("Unknown path.", 404);
  }).pipe(
    // Anything unexpected is answered 500, which the Runner retries.
    Effect.catchCause((cause) =>
      Effect.logError("session request failed", Cause.pretty(cause)).pipe(
        Effect.as(text("The session store is unavailable right now.", 500)),
      ),
    ),
  );
