import { API_VERSION } from "@signalbox/api/catalog";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";

import type { Target } from "./target.ts";

/** The public API over HTTP (`apps/cloud/src/api/apiRoutes.ts`). */

export class CliApiError extends Schema.TaggedError<CliApiError>()("CliApiError", {
  status: Schema.Number,
  /** The API's error body, or the text it answered with. */
  body: Schema.Unknown,
}) {
  override get message(): string {
    const error = (this.body as { readonly error?: { readonly message?: unknown } } | null)?.error;
    return typeof error?.message === "string"
      ? error.message
      : `Signalbox answered ${this.status}: ${JSON.stringify(this.body)}`;
  }
}

export class CliNotSignedInError extends Schema.TaggedError<CliNotSignedInError>()(
  "CliNotSignedInError",
  { url: Schema.String },
) {
  override get message(): string {
    return `Not signed in to ${this.url}. Run \`signalbox login\`, or set SIGNALBOX_KEY.`;
  }
}

const endpoint = (target: Target, path: string) => `${target.url}/api/${API_VERSION}/${path}`;

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const send = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(request);
    const text = yield* response.text;
    const body = text.trim() === "" ? null : Option.getOrElse(decodeJson(text), () => text);
    return { status: response.status, body };
  });

/** Marks a call as an agent's (`signalbox mcp`); it can only narrow what the key may do. */
const CALLER_HEADER = "x-signalbox-caller";

/** A POST that answers JSON; anything but 2xx fails with what the API said. */
export const postJson = (
  target: Target,
  path: string,
  body: unknown,
  key?: string,
  options: { readonly asAgent?: boolean } = {},
) =>
  Effect.gen(function* () {
    const request = HttpClientRequest.post(endpoint(target, path)).pipe(
      HttpClientRequest.bodyJsonUnsafe(body),
      key === undefined ? (self) => self : HttpClientRequest.bearerToken(key),
      options.asAgent === true
        ? HttpClientRequest.setHeader(CALLER_HEADER, "agent")
        : (self) => self,
    );
    const answer = yield* send(request);
    if (answer.status < 200 || answer.status >= 300) {
      return yield* new CliApiError({ status: answer.status, body: answer.body });
    }
    return answer.body;
  });

const keyOf = (target: Target) =>
  Option.match(target.key, {
    onNone: () => Effect.fail(new CliNotSignedInError({ url: target.url })),
    onSome: Effect.succeed,
  });

/** Calls an operation as the signed-in person, or as an agent working for them. */
export const callOperation = (
  target: Target,
  name: string,
  input: unknown,
  options: { readonly asAgent?: boolean } = {},
) => Effect.flatMap(keyOf(target), (key) => postJson(target, name, input, key, options));

const Listing = Schema.Struct({
  operations: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      cloud: Schema.Struct({
        served: Schema.Boolean,
        issue: Schema.optionalKey(Schema.String),
        reason: Schema.optionalKey(Schema.String),
      }),
    }),
  ),
});

const decodeListing = Schema.decodeUnknownEffect(Listing);

/** Which operations this Signalbox serves, by name (`GET operations`). */
export const listCoverage = (target: Target) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(endpoint(target, "operations"));
    const listing = yield* decodeListing(yield* response.json);
    return new Map(listing.operations.map((operation) => [operation.name, operation.cloud]));
  });

/** Follows a streaming operation: one JSON value per line, as the API sends them. */
export const followOperation = (target: Target, name: string, input: unknown) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const key = yield* keyOf(target);
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(
        HttpClientRequest.post(`${endpoint(target, name)}?follow=1`).pipe(
          HttpClientRequest.bodyJsonUnsafe(input),
          HttpClientRequest.bearerToken(key),
        ),
      );
      if (response.status < 200 || response.status >= 300) {
        const text = yield* response.text;
        return yield* new CliApiError({
          status: response.status,
          body: Option.getOrElse(decodeJson(text), () => text),
        });
      }
      return response.stream.pipe(Stream.decodeText, Stream.splitLines);
    }),
  );

/** What `POST login` answers: WorkOS's device authorization. */
export const DeviceLogin = Schema.Struct({
  deviceCode: Schema.String,
  userCode: Schema.String,
  verificationUri: Schema.String,
  verificationUriComplete: Schema.String,
  expiresIn: Schema.Number,
  interval: Schema.Number,
});
export type DeviceLogin = typeof DeviceLogin.Type;

export const startLogin = (target: Target) =>
  Effect.flatMap(postJson(target, "login", {}), Schema.decodeUnknownEffect(DeviceLogin));

const LoginKey = Schema.Struct({ key: Schema.String });
const PendingLogin = Schema.Struct({
  error: Schema.Literals(["authorization_pending", "slow_down"]),
});
const isPending = Schema.is(PendingLogin);

/** One poll of `POST login/token`: the key, or `pending` / `slow_down` until the person approves. */
export const pollLogin = (target: Target, deviceCode: string, label: string) =>
  postJson(target, "login/token", { deviceCode, label }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(LoginKey)),
    Effect.map((answer) => ({ _tag: "signed-in", key: answer.key }) as const),
    Effect.catchTags({
      CliApiError: (error) =>
        error.status === 400 && isPending(error.body)
          ? Effect.succeed({ _tag: error.body.error } as const)
          : Effect.fail(error),
    }),
  );
