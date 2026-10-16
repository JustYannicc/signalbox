import type { ModelGatewayProvider } from "@signalbox/runner-protocol/RunnerProtocol";
import { POOL_LINK_PATH, PoolLinkMoveRequest } from "@t3tools/contracts/accountHub";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { bearerOrKey, errorResponse, withoutCaller } from "../modelGateway/modelGateway.ts";
import type { PoolBackendError } from "./cliProxyApi.ts";
import { poolObjectStub, type PoolObjectNamespace } from "./PoolDirectory.ts";
import * as PoolEngine from "./PoolEngine.ts";
import * as PoolLinks from "./PoolLinks.ts";
import * as ThreadAccounts from "./threadAccounts.ts";

/**
 * The pool link's HTTP API (`POOL_LINK_PATH` in the contracts): how a
 * self-hosted server reaches the cloud pool it moved its own pool into. The
 * token names the pool's object and carries a secret only that object can
 * check, so the Worker routes it without reading anything.
 *
 * The server's harnesses use `/v1/*` as their provider API, exactly as they
 * used the server's own hub, so its threads keep running on the pool.
 *
 * A pool elsewhere can use a link as its external backing: that's how a
 * preview's pools run on production's (`previewSetup/`). It reads the pool
 * with `GET`, like a server does. Everything that changes accounts stays
 * with this pool. Previews built before that read the v0 management routes
 * (`config` and `auth-files`), which stay until no such preview is left.
 */

const TOKEN_PREFIX = "sbpl_";

/** The token a server keeps: the pool's object name, then the link's secret. */
export const encodeLinkToken = (objectName: string, secret: string) =>
  `${TOKEN_PREFIX}${Base64Url.encode(objectName)}.${secret}`;

export const decodeLinkToken = (token: string) => {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const [encoded, secret, ...rest] = token.slice(TOKEN_PREFIX.length).split(".");
  if (encoded === undefined || !secret || rest.length > 0) return null;
  const decoded = Base64Url.decode(encoded);
  if (!Result.isSuccess(decoded)) return null;
  const objectName = new TextDecoder().decode(decoded.success);
  return objectName ? { objectName, secret } : null;
};

export const isPoolLinkPath = (pathname: string) =>
  pathname === POOL_LINK_PATH || pathname.startsWith(`${POOL_LINK_PATH}/`);

/** Which provider API a link path speaks, so errors come back in its shape. */
const providerOf = (pathname: string): ModelGatewayProvider =>
  pathname.includes("/v1/responses") ? "openai" : "anthropic";

/** An error both provider APIs' clients print, and the server's link client reads. */
const failure = (request: Request, status: number, message: string) =>
  errorResponse(providerOf(new URL(request.url).pathname), status, message);

/** What a pool object answers on its links (`linkFetch`). */
export interface PoolLinkTarget {
  readonly linkFetch: (secret: string, request: Request) => Promise<Response>;
}

/** The Worker's side: finds the pool the token names and lets its object answer. */
export const routePoolLink = (
  namespace: PoolObjectNamespace,
  request: Request,
  options: { readonly localWorkerd: boolean },
): Promise<Response> => {
  const token = bearerOrKey(request.headers);
  const decoded = token === null ? null : decodeLinkToken(token);
  if (decoded === null) {
    return Promise.resolve(failure(request, 401, "Missing or malformed pool link."));
  }
  return poolObjectStub(namespace, decoded.objectName, options).linkFetch(decoded.secret, request);
};

const decodeMoveRequest = Schema.decodeUnknownEffect(PoolLinkMoveRequest);

/** The pool object's side: checks the link, then serves the request as the user it acts for. */
export const handleLinkRequest = (secret: string, request: Request) =>
  Effect.gen(function* () {
    const engine = yield* PoolEngine.PoolEngine;
    const links = yield* PoolLinks.PoolLinks;
    const link = yield* links.resolve(secret);
    if (link === null) return failure(request, 401, "This pool link no longer works.");
    const actor = { userId: link.userId };
    const url = new URL(request.url);
    const path = url.pathname.slice(POOL_LINK_PATH.length);
    if (path.startsWith("/v1/")) {
      // The link token stays here; the pool sends its own key.
      const { thread, headers } = ThreadAccounts.threadOfLinkRequest(request);
      const forwarded = new Request(request, { headers: withoutCaller(headers) });
      const reply = yield* engine.forwardModel(actor, `${path}${url.search}`, forwarded, thread);
      return ThreadAccounts.markMoved(reply);
    }
    if (path === "" && request.method === "GET") {
      return Response.json(yield* engine.linkInfo(actor));
    }
    if (path === "/v0/management/config" && request.method === "GET") {
      yield* engine.info(actor);
      return Response.json({});
    }
    if (path === "/v0/management/auth-files" && request.method === "GET") {
      const { accounts, role } = yield* engine.accounts(actor);
      // The fields `cliProxyApi.listAccounts` reads, signed-out ones as CLIProxyAPI marks them.
      return Response.json({
        files: accounts.map((account) => ({
          name: account.name,
          type: account.type,
          ...(account.email === null || role !== "admin" ? {} : { email: account.email }),
          disabled: account.disabled,
          ...(account.signedOut ? { status: "error", unavailable: true } : {}),
        })),
      });
    }
    if (path === "/accounts" && request.method === "POST") {
      if (!link.moveOpen) {
        return failure(
          request,
          403,
          "This pool link no longer takes accounts. Start the move again.",
        );
      }
      const body = yield* Effect.tryPromise(() => request.json()).pipe(
        Effect.flatMap(decodeMoveRequest),
        Effect.option,
      );
      if (body._tag === "None") return failure(request, 400, "That is not a list of accounts.");
      const moved = yield* engine.importAccounts(actor, body.value.accounts);
      // The move landed: the link now lasts as long as the grant behind it.
      yield* links.claim(secret);
      return Response.json(moved);
    }
    return failure(request, 404, `A pool link does not serve ${request.method} ${path || "/"}.`);
  }).pipe(
    Effect.catchTags({
      PoolRejectedError: (error: PoolEngine.PoolRejectedError) =>
        Effect.succeed(failure(request, 403, error.reason)),
      PoolBackendError: (error: PoolBackendError) =>
        Effect.logWarning("pool link request failed", error.detail, error.cause).pipe(
          Effect.as(failure(request, 502, error.detail)),
        ),
      SqlError: (cause) =>
        Effect.logError("pool link storage failed", { cause }).pipe(
          Effect.as(failure(request, 500, "The pool could not be read. Try again.")),
        ),
    }),
  );
