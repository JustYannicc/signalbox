import { AuthOrchestrationReadScope, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest } from "effect/http";

import * as CloudSessions from "../auth/CloudSessions.ts";
import * as CloudThreadService from "../thread/CloudThreadService.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import { failure, json, requestCredentials } from "./credentials.ts";

/**
 * A thread's turn diagnostics, for its owner (see
 * `CloudThreadService.turnDiagnostics`):
 *
 * - `GET /api/cloud/threads/:threadId/diagnostics`: the recent turns, each
 *   with its trace id, status and failure.
 * - `GET /api/cloud/threads/:threadId/diagnostics/:key`: one turn's record,
 *   by its run id or trace id.
 *
 * Authenticated like the environment API: the session cookie or a bearer
 * token with the orchestration read scope.
 */

export const DIAGNOSTICS_PATH = "/api/cloud/threads/:threadId/diagnostics";

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

const internalError = (cause: unknown) =>
  Effect.logError("cloud diagnostics failed", { cause }).pipe(
    Effect.andThen(failure("internal_error", 500)),
  );

const diagnostics = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const params = yield* HttpRouter.params;
  const session = yield* (yield* CloudSessions.CloudSessions).authenticate(
    requestCredentials(request),
  );
  if (!session.scopes.includes(AuthOrchestrationReadScope)) {
    return yield* failure("insufficient_scope", 403);
  }
  const threadId = decodeThreadId(params.threadId);
  if (threadId._tag === "None") return yield* failure("not_found", 404);
  const contextIds = yield* (yield* UserDirectory.UserDirectory)
    .forUser(session.userId)
    .contextIds();
  const record = yield* (yield* CloudThreadService.CloudThreadService).turnDiagnostics(
    { userId: session.userId, contextIds },
    threadId.value,
    params.key ?? null,
  );
  return record === null ? yield* failure("not_found", 404) : json(record, 200);
}).pipe(
  Effect.catchTags({
    CloudCredentialError: () => failure("auth_invalid", 401),
    UserObjectError: internalError,
    ThreadObjectError: internalError,
  }),
);

export const layer = Layer.mergeAll(
  HttpRouter.add("GET", DIAGNOSTICS_PATH, diagnostics),
  HttpRouter.add("GET", `${DIAGNOSTICS_PATH}/:key`, diagnostics),
);
