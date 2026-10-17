import { findOperation, jsonSchemaOf, type Operation, operations } from "@signalbox/api/catalog";
import * as WorkOSClient from "@signalbox/account/WorkOSClient";
import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

import * as CloudConfig from "../CloudConfig.ts";
import { NO_STORE_HEADERS } from "../http/credentials.ts";
import { isLocalKey, signLocalKey, verifyLocalKey } from "../localKeys/LocalKeys.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import { cloudServes, cloudUnserved } from "./cloudCoverage.ts";
import { API_PREFIX } from "./apiPaths.ts";

/**
 * The public API's HTTP surface (#436), under `/api/v1/`:
 *
 * - `GET operations` lists every operation, with whether this cloud serves it;
 *   `GET operations/<name>` adds its input and output JSON Schemas.
 * - `POST login` and `POST login/token`: the CLI's sign-in. The cloud runs
 *   WorkOS's device flow (CLI Auth) itself and, once the person approves it in
 *   their browser, answers with a personal key. The CLI never holds a WorkOS token.
 * - `POST <operation>` calls an operation with a personal key as bearer. The
 *   user's object answers it (`apiObject.ts`).
 */

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: NO_STORE_HEADERS });

const problem = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);

const coverage = (operation: Operation) => {
  if (cloudServes(operation)) return { served: true } as const;
  const unserved = cloudUnserved(operation);
  return {
    served: false,
    ...(unserved?._tag === "gap" ? { issue: unserved.issue } : {}),
    ...(unserved?._tag === "exempt" ? { reason: unserved.reason } : {}),
  } as const;
};

const summaryOf = (operation: Operation) => ({
  name: operation.name,
  ...(operation.summary === undefined ? {} : { summary: operation.summary }),
  access: operation.access,
  ...(operation.stream === undefined ? {} : { stream: operation.stream }),
  ...(operation.humanOnly ? { humanOnly: true } : {}),
  ...(operation.destructive ? { destructive: true } : {}),
  ...(operation.destructive && operation.agentCallable ? { agentCallable: true } : {}),
  // Scripts calling the API directly compile `source` themselves, as the CLI does.
  ...(operation.compiles ? { compiles: true } : {}),
  cloud: coverage(operation),
});

const detailOf = (operation: Operation) => {
  const input = jsonSchemaOf(operation.input);
  const output = jsonSchemaOf(operation.output);
  return {
    ...summaryOf(operation),
    input: { ...input.schema, $defs: input.definitions },
    output: { ...output.schema, $defs: output.definitions },
  };
};

/** What a personal key made by `signalbox login` may do: what a signed-in app may. */
const CLI_KEY_SCOPES = AuthStandardClientScopes;

const LoginToken = Schema.Struct({
  deviceCode: Schema.String,
  /** Names the key in Settings, e.g. the computer's host name. */
  label: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
});
const decodeLoginToken = Schema.decodeUnknownOption(LoginToken);

const startLogin = Effect.gen(function* () {
  const { accounts } = yield* CloudConfig.CloudConfig;
  const device = yield* WorkOSClient.authorizeDevice(accounts.workos);
  return json(device);
}).pipe(
  Effect.catchTags({
    WorkOSAuthenticateError: (error) =>
      Effect.logError("cli login start failed", { error: error.message }).pipe(
        Effect.as(problem(502, "workos_unavailable", "Couldn't start sign-in. Try again.")),
      ),
  }),
);

/** RFC 8628's polling answers, passed through so the CLI can wait or stop. */
const DEVICE_ERRORS = new Set([
  "authorization_pending",
  "slow_down",
  "access_denied",
  "expired_token",
]);

const finishLogin = (request: Request) =>
  Effect.gen(function* () {
    const body = decodeLoginToken(yield* Effect.promise(() => request.json().catch(() => null)));
    if (body._tag === "None") return problem(400, "invalid_input", "Send { deviceCode }.");
    const { accounts } = yield* CloudConfig.CloudConfig;
    const user = yield* WorkOSClient.authenticate(accounts.workos, {
      kind: "device-code",
      deviceCode: body.value.deviceCode,
    });
    const users = yield* UserDirectory.UserDirectory;
    const handle = users.forUser(user.id);
    if ((yield* handle.profile()) === null) {
      return problem(403, "no_account", "Sign in to Signalbox on the web once first.");
    }
    const created = yield* handle.createLocalKey(`CLI · ${body.value.label ?? "computer"}`, {
      scopes: CLI_KEY_SCOPES,
      model: false,
    });
    if (created._tag === "limit") {
      return problem(409, "limit", "Revoke a key you no longer use in Settings first.");
    }
    return json({ key: yield* signLocalKey(user.id, created.secret), userId: user.id });
  }).pipe(
    Effect.catchTags({
      WorkOSAuthenticateError: (error) =>
        error.error !== undefined && DEVICE_ERRORS.has(error.error)
          ? Effect.succeed(json({ error: error.error }, 400))
          : Effect.logError("cli login failed", { error: error.message }).pipe(
              Effect.as(problem(502, "workos_unavailable", "Couldn't finish sign-in. Try again.")),
            ),
      WorkOSEmailVerificationRequired: () =>
        Effect.succeed(problem(403, "verify_email", "Sign in to Signalbox on the web once first.")),
      UserObjectError: (error) =>
        Effect.logError("cli login failed", { cause: error }).pipe(
          Effect.as(problem(500, "internal", "Something went wrong. Try again.")),
        ),
    }),
  );

/** `agent` when an agent makes the call with its person's key (`signalbox mcp`). */
export const CALLER_HEADER = "x-signalbox-caller";

const bearer = (request: Request) => {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() ?? null;
};

const callOperation = (request: Request) =>
  Effect.gen(function* () {
    const token = bearer(request);
    if (token === null || !isLocalKey(token)) {
      return problem(401, "unauthorized", "Send a personal key as `Authorization: Bearer sbk_…`.");
    }
    const key = yield* verifyLocalKey(token);
    if (key === null) return problem(401, "unauthorized", "This key isn't one this cloud made.");
    return yield* (yield* UserDirectory.UserDirectory).callApi(key.userId, request, {
      _tag: "key",
      secret: key.secret,
      // Only ever narrows: an agent's call never gets more than the person's would.
      ...(request.headers.get(CALLER_HEADER) === "agent" ? { agent: true } : {}),
    });
  }).pipe(
    Effect.catchTags({
      UserObjectError: (error) =>
        Effect.logError("api call failed", { cause: error }).pipe(
          Effect.as(problem(500, "internal", "Something went wrong. Try again.")),
        ),
    }),
  );

/** Answers anything under `/api/v1/`. */
export const handleApiRequest = (request: Request) =>
  Effect.gen(function* () {
    const path = new URL(request.url).pathname.slice(API_PREFIX.length);
    if (request.method === "GET" && path === "operations") {
      return json({ operations: operations.map(summaryOf) });
    }
    if (request.method === "GET" && path.startsWith("operations/")) {
      const operation = findOperation(decodeURIComponent(path.slice("operations/".length)));
      return operation === undefined
        ? problem(404, "unknown_operation", "There's no such operation.")
        : json(detailOf(operation));
    }
    if (request.method !== "POST") return problem(405, "method", "Call operations with POST.");
    if (path === "login") return yield* startLogin;
    if (path === "login/token") return yield* finishLogin(request);
    return yield* callOperation(request);
  });

export type ApiRouteServices =
  | CloudConfig.CloudConfig
  | HttpClient.HttpClient
  | UserDirectory.UserDirectory
  | Effect.Services<ReturnType<typeof verifyLocalKey>>;
