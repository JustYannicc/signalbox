import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest } from "effect/http";

import * as CloudSessions from "../auth/CloudSessions.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import { failure, json, requestCredentials } from "./credentials.ts";

/**
 * A test clock for idle chats archiving themselves (#46), on previews only:
 * `POST /api/cloud/thread-kinds/sweep` with `{ "asOf": "<ISO time>" }` runs
 * the caller's own sweep as if it were that time, and answers
 * `{ archived: [threadId…] }`. Served only where the Worker var
 * `THREAD_KIND_TEST_CLOCK` is `1`; everywhere else it's a 404. Authenticated
 * like the environment API, with the orchestration operate scope.
 */

export const THREAD_KIND_SWEEP_PATH = "/api/cloud/thread-kinds/sweep";

/** Whether this deployment serves the test clock, read once from the Worker's vars. */
export class ThreadKindTestClock extends Context.Service<
  ThreadKindTestClock,
  { readonly enabled: boolean }
>()("@signalbox/cloud/http/threadKindRoutes/ThreadKindTestClock") {}

export const layerTestClock = Layer.effect(
  ThreadKindTestClock,
  Effect.gen(function* () {
    const value = yield* Config.String("THREAD_KIND_TEST_CLOCK").pipe(Config.option);
    return ThreadKindTestClock.of({ enabled: Option.getOrUndefined(value) === "1" });
  }),
);

const decodeBody = Schema.decodeUnknownOption(Schema.Struct({ asOf: Schema.String }));

const sweep = Effect.gen(function* () {
  if (!(yield* ThreadKindTestClock).enabled) return yield* failure("not_found", 404);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const session = yield* (yield* CloudSessions.CloudSessions).authenticate(
    requestCredentials(request),
  );
  if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
    return yield* failure("insufficient_scope", 403);
  }
  const body = decodeBody(yield* Effect.orElseSucceed(request.json, () => null));
  const asOfMs = Option.isSome(body) ? Date.parse(body.value.asOf) : Number.NaN;
  if (Number.isNaN(asOfMs)) return yield* failure("invalid_request", 400);
  const result = yield* (yield* UserDirectory.UserDirectory)
    .forUser(session.userId)
    .sweepThreadKinds(asOfMs);
  return json({ archived: result.archived }, 200);
}).pipe(
  Effect.catchTags({
    CloudCredentialError: () => failure("auth_invalid", 401),
    UserObjectError: (cause) =>
      Effect.logError("cloud thread kind sweep failed", { cause }).pipe(
        Effect.andThen(failure("internal_error", 500)),
      ),
  }),
);

export const layer = HttpRouter.add("POST", THREAD_KIND_SWEEP_PATH, sweep);
