import { findOperation } from "@signalbox/api/catalog";
import { AuthEnvironmentScopes } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type * as Environment from "../environment.ts";
import { NO_STORE_HEADERS } from "../http/credentials.ts";
import * as LocalKeys from "../localKeys/LocalKeys.ts";
import { type ApiAnswer, type ApiCaller, callOperation, dimensionsOf } from "./apiCall.ts";
import { API_PREFIX } from "./apiPaths.ts";

/**
 * The public API inside a user's object. The Worker checked only that the
 * credential is the cloud's (a key's signature, an MCP token's issuer); the
 * object holds the record, so a revoked key stops at the next call.
 */

/** Carries a call's credential from the Worker. Objects aren't reachable from the internet. */
export const API_HEADER = "x-signalbox-api";

export const ApiCredential = Schema.Union([
  /**
   * A personal key; the object looks up its scopes. `agent`: an agent is using
   * the person's key (`signalbox mcp`), so the call gets an agent's limits.
   */
  Schema.TaggedStruct("key", { secret: Schema.String, agent: Schema.optionalKey(Schema.Boolean) }),
  /** An agent acting for the person, as the Worker verified (MCP). */
  Schema.TaggedStruct("agent", { sid: Schema.String, scopes: AuthEnvironmentScopes }),
]);
export type ApiCredential = typeof ApiCredential.Type;
export const encodeApiCredential = Schema.encodeSync(Schema.fromJsonString(ApiCredential));
export const decodeApiCredential = Schema.decodeUnknownOption(Schema.fromJsonString(ApiCredential));

const respond = (answer: ApiAnswer): Response =>
  answer._tag === "json"
    ? Response.json(answer.body, { status: answer.status, headers: NO_STORE_HEADERS })
    : new Response(Stream.toReadableStream(Stream.encodeText(answer.lines)), {
        headers: { ...NO_STORE_HEADERS, "content-type": "application/x-ndjson" },
      });

const refused = (status: number, code: string, message: string): ApiAnswer => ({
  _tag: "json",
  status,
  body: { error: { code, message } },
});

export const callerFor = (credential: ApiCredential, userId: string) =>
  Effect.gen(function* () {
    if (credential._tag === "agent") {
      return {
        userId,
        kind: "agent",
        scopes: credential.scopes,
        credentialId: credential.sid,
      } satisfies ApiCaller;
    }
    const access = yield* (yield* LocalKeys.LocalKeys).access(credential.secret);
    if (access === null) return null;
    return {
      userId,
      kind: credential.agent === true ? "agent" : "person",
      scopes: access.scopes,
      credentialId: access.id,
    } satisfies ApiCaller;
  });

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** The request's JSON body; an empty one is `{}`, an operation with no input. */
const readBody = (request: Request) =>
  Effect.map(
    Effect.promise(() => request.text()),
    (text) => {
      if (text.trim() === "") return { _tag: "ok", body: {} } as const;
      const parsed = decodeJson(text);
      return parsed._tag === "Some"
        ? ({ _tag: "ok", body: parsed.value } as const)
        : ({ _tag: "invalid" } as const);
    },
  );

/** `POST /api/v1/<operation>` as the object answers it. */
export const serveApiRequest = Effect.fn("api.request")(function* (
  request: Request,
  input: {
    readonly identity: Environment.CloudEnvironmentIdentity;
    readonly userId: string;
    readonly credential: ApiCredential;
  },
) {
  const startedAt = yield* Clock.currentTimeMillis;
  const url = new URL(request.url);
  const name = decodeURIComponent(url.pathname.slice(API_PREFIX.length));
  const caller = yield* callerFor(input.credential, input.userId).pipe(
    Effect.catchTags({
      SqlError: (cause) =>
        Effect.logError("api key lookup failed", { cause }).pipe(Effect.as(undefined)),
    }),
  );
  const operation = findOperation(name);
  const body = yield* readBody(request);
  const answer: ApiAnswer =
    caller === undefined
      ? refused(500, "internal", "Something went wrong. Try again.")
      : caller === null
        ? refused(401, "unauthorized", "This key was revoked or can't call the API.")
        : operation === undefined
          ? refused(404, "unknown_operation", `There's no operation called ${name}.`)
          : body._tag === "invalid"
            ? refused(400, "invalid_json", "The request body isn't JSON.")
            : yield* callOperation({
                operation,
                body: body.body,
                follow: url.searchParams.get("follow") === "1",
                caller,
                identity: input.identity,
              });
  // One line per call: who, where and how it went. Never the input or the result (#284).
  yield* Effect.logInfo("api.call").pipe(
    Effect.annotateLogs({
      "person.id": input.userId,
      "api.operation": name,
      "api.caller": caller?.kind ?? "unknown",
      "api.credential": caller?.credentialId ?? "none",
      "api.status": answer._tag === "json" ? answer.status : 200,
      "api.ms": (yield* Clock.currentTimeMillis) - startedAt,
      ...(body._tag === "ok" ? dimensionsOf(body.body) : {}),
    }),
  );
  return respond(answer);
});
