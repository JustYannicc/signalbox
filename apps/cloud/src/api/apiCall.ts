import type { Operation, WireSchema } from "@signalbox/api/catalog";
import { type AuthEnvironmentScope, CommandId, WsRpcGroup } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import type * as Environment from "../environment.ts";
import * as CloudRpc from "../user/rpc.ts";
import { cloudServes, cloudUnserved } from "./cloudCoverage.ts";

/**
 * One public API call, answered inside the caller's own user object. The
 * operation runs through `CloudRpcGroup`'s handlers and scope authorization,
 * the same ones a client's socket gets (`user/connection.ts`), so the API
 * can't do anything the app can't, and acts within the person's folders the
 * way the app does.
 */

/** Who a call acts for, as their credential says. */
export interface ApiCaller {
  readonly userId: string;
  /** A person's own key or session, or an agent acting for them (MCP). */
  readonly kind: "person" | "agent";
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  /** The credential's id: a key's public id or a session's sid. Never a secret. */
  readonly credentialId: string;
}

/** An RPC's failure: one of its contract's tagged errors. */
type RpcFailure = { readonly _tag: string };

/** What the HTTP layer sends back. */
export type ApiAnswer =
  | { readonly _tag: "json"; readonly status: number; readonly body: unknown }
  | { readonly _tag: "ndjson"; readonly lines: Stream.Stream<string> };

export interface ApiCallInput {
  readonly operation: Operation;
  readonly body: unknown;
  /** Send every stream item as a line instead of one answer. */
  readonly follow: boolean;
  readonly caller: ApiCaller;
  readonly identity: Environment.CloudEnvironmentIdentity;
}

const problem = (status: number, code: string, message: string, extra?: object): ApiAnswer => ({
  _tag: "json",
  status,
  body: { error: { code, message, ...extra } },
});

const jsonCodec = (schema: WireSchema) => Schema.toCodecJson(schema);

/** Why an agent may not call `operation`, or undefined. */
const agentRefusal = (operation: Operation) =>
  operation.humanOnly
    ? "Only you can do this. Answer it in Signalbox."
    : operation.destructive
      ? "Agents can't delete things yet; that needs a decision gate (#335)."
      : undefined;

/** The RPC payload for the caller's input: commands get their `type` and an id. */
const rpcPayload = (operation: Operation, body: unknown) =>
  Effect.gen(function* () {
    if (operation.command === undefined) return body;
    const input = typeof body === "object" && body !== null ? body : {};
    const commandId =
      "commandId" in input && typeof input.commandId === "string"
        ? input.commandId
        : CommandId.make(yield* Effect.orDie((yield* Crypto.Crypto).randomUUIDv4()));
    return { ...input, type: operation.command, commandId };
  });

/** A failure as the API answers it: the contract's error, encoded, or a bug. */
const failure = (operation: Operation, cause: Cause.Cause<RpcFailure | Schema.SchemaError>) =>
  Effect.gen(function* () {
    const error = Cause.findErrorOption(cause);
    if (Option.isNone(error)) {
      yield* Effect.logError("api call failed", { operation: operation.name, cause });
      return problem(500, "internal", "Something went wrong. Try again.");
    }
    const encoded = yield* Schema.encodeUnknownEffect(jsonCodec(operation.error))(error.value).pipe(
      Effect.option,
    );
    const tag = error.value._tag;
    const status = tag === "EnvironmentAuthorizationError" ? 403 : 422;
    return {
      _tag: "json" as const,
      status,
      body: { error: Option.getOrElse(encoded, () => ({ _tag: tag })) },
    };
  });

export const callOperation = Effect.fn("api.call")(function* (input: ApiCallInput) {
  const { operation, caller } = input;
  yield* Effect.annotateCurrentSpan({
    "person.id": caller.userId,
    "api.operation": operation.name,
    "api.caller": caller.kind,
  });

  if (caller.kind === "agent") {
    const refusal = agentRefusal(operation);
    if (refusal !== undefined) return problem(403, "people_only", refusal);
  }
  if (!cloudServes(operation)) {
    const unserved = cloudUnserved(operation);
    return problem(501, "not_in_cloud", `${operation.name} isn't available in the cloud yet.`, {
      ...(unserved?._tag === "gap" ? { issue: unserved.issue } : {}),
      ...(unserved?._tag === "exempt" ? { reason: unserved.reason } : {}),
    });
  }

  // The RPC's own payload: for commands, the whole command `rpcPayload` assembled.
  const payloadSchema = WsRpcGroup.requests.get(operation.rpc)!.payloadSchema as WireSchema;
  const decoded = yield* rpcPayload(operation, input.body).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(jsonCodec(payloadSchema))),
    Effect.result,
  );
  if (decoded._tag === "Failure") {
    return problem(400, "invalid_input", decoded.failure.message);
  }
  yield* Effect.annotateCurrentSpan(dimensionsOf(decoded.success));

  // The client lives in a scope: a one-shot call's, or a followed stream's own.
  const client = RpcTest.makeClient(CloudRpc.CloudRpcGroup, { flatten: true }).pipe(
    Effect.provide(
      Layer.mergeAll(
        CloudRpc.layerHandlers({
          identity: input.identity,
          userId: caller.userId,
          sid: caller.credentialId,
          scopes: caller.scopes,
        }),
        CloudRpc.layerScopeAuthorization(caller.scopes),
      ),
    ),
    // One signature for every tag: the payload was decoded with the RPC's own schema.
    Effect.map(
      (flat) =>
        flat as unknown as (
          tag: string,
          payload: unknown,
        ) => Effect.Effect<unknown, RpcFailure> | Stream.Stream<unknown, RpcFailure>,
    ),
  );
  const call = (payload: unknown) =>
    Effect.map(client, (rpcCall) => rpcCall(operation.rpc, payload));
  const encode = Schema.encodeUnknownEffect(jsonCodec(operation.output));

  if (operation.stream === undefined) {
    const exit = yield* call(decoded.success).pipe(
      Effect.flatMap((result) => result as Effect.Effect<unknown, RpcFailure>),
      Effect.scoped,
      Effect.exit,
    );
    if (Exit.isFailure(exit)) return yield* failure(operation, exit.cause);
    const body = yield* encode(exit.value).pipe(Effect.orDie);
    return { _tag: "json", status: 200, body } satisfies ApiAnswer;
  }

  // A followed stream runs after this call returns, so it carries the call's services along.
  const context = yield* Effect.context<Exclude<Effect.Services<typeof client>, Scope.Scope>>();
  const items = Stream.unwrap(
    Effect.map(call(decoded.success), (result) => result as Stream.Stream<unknown, RpcFailure>),
  ).pipe(Stream.provideContext(context));
  if (input.follow) {
    return {
      _tag: "ndjson",
      lines: items.pipe(
        Stream.mapEffect((item) => encode(item)),
        Stream.map((item) => `${JSON.stringify(item)}\n`),
        Stream.catchCause((cause) =>
          Stream.fromEffect(
            failure(operation, cause).pipe(
              Effect.map((answer) =>
                answer._tag === "json" ? `${JSON.stringify(answer.body)}\n` : "",
              ),
            ),
          ),
        ),
      ),
    } satisfies ApiAnswer;
  }
  const picked = yield* Effect.exit(
    operation.stream === "snapshot" ? Stream.runHead(items) : Stream.runLast(items),
  );
  if (Exit.isFailure(picked)) return yield* failure(operation, picked.cause);
  if (Option.isNone(picked.value))
    return { _tag: "json", status: 200, body: null } satisfies ApiAnswer;
  return {
    _tag: "json",
    status: 200,
    body: yield* encode(picked.value.value).pipe(Effect.orDie),
  } satisfies ApiAnswer;
});

/**
 * The ids a call names, for its span and log line: the folder (#225) and the
 * thread. Inputs and results never go on either (#284).
 */
export const dimensionsOf = (payload: unknown): Record<string, string> => {
  if (typeof payload !== "object" || payload === null) return {};
  const fields = payload as Record<string, unknown>;
  const folder = fields.folderId ?? fields.projectId;
  return {
    ...(typeof folder === "string" ? { "folder.id": folder } : {}),
    ...(typeof fields.threadId === "string" ? { "thread.id": fields.threadId } : {}),
  };
};
