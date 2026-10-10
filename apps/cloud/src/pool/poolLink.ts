import {
  POOL_LINK_PATH,
  type PoolLinkInfo,
  PoolLinkMoveRequest,
} from "@t3tools/contracts/accountHub";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { PoolBackendError } from "./cliProxyApi.ts";
import { poolObjectStub, type PoolObjectNamespace } from "./PoolDirectory.ts";
import * as PoolEngine from "./PoolEngine.ts";
import * as PoolLinks from "./PoolLinks.ts";

/**
 * The pool link's HTTP API (`POOL_LINK_PATH` in the contracts): how a
 * self-hosted server reaches the cloud pool it moved its own pool into. The
 * token names the pool's object and carries a secret only that object can
 * check, so the Worker routes it without reading anything.
 *
 * The server's harnesses use `/v1/*` as their provider API, exactly as they
 * used the server's own hub, so its threads keep running on the pool.
 */

const TOKEN_PREFIX = "sbpl_";

const toBase64Url = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

const fromBase64Url = (encoded: string) => {
  try {
    const binary = atob(encoded.replaceAll("-", "+").replaceAll("_", "/"));
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
};

/** The token a server keeps: the pool's object name, then the link's secret. */
export const encodeLinkToken = (objectName: string, secret: string) =>
  `${TOKEN_PREFIX}${toBase64Url(objectName)}.${secret}`;

export const decodeLinkToken = (token: string) => {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const [encoded, secret, ...rest] = token.slice(TOKEN_PREFIX.length).split(".");
  if (encoded === undefined || !secret || rest.length > 0) return null;
  const objectName = fromBase64Url(encoded);
  return objectName ? { objectName, secret } : null;
};

export const isPoolLinkPath = (pathname: string) =>
  pathname === POOL_LINK_PATH || pathname.startsWith(`${POOL_LINK_PATH}/`);

/** The bearer token, or the API key Claude Code sends when given one. */
const tokenOf = (headers: Headers) => {
  const key = headers.get("x-api-key");
  if (key) return key;
  const match = /^Bearer\s+(.+)$/iu.exec(headers.get("authorization") ?? "");
  return match?.[1]?.trim() ?? null;
};

/** Errors in the shape both provider APIs' clients print. */
const failure = (status: number, message: string) =>
  Response.json({ type: "error", error: { type: "pool_link_error", message } }, { status });

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
  const token = tokenOf(request.headers);
  const decoded = token === null ? null : decodeLinkToken(token);
  if (decoded === null) return Promise.resolve(failure(401, "Missing or malformed pool link."));
  return poolObjectStub(namespace, decoded.objectName, options).linkFetch(decoded.secret, request);
};

const decodeMoveRequest = Schema.decodeUnknownEffect(PoolLinkMoveRequest);

/** The pool object's side: checks the link, then serves the request as the user it acts for. */
export const handleLinkRequest = (secret: string, request: Request) =>
  Effect.gen(function* () {
    const engine = yield* PoolEngine.PoolEngine;
    const links = yield* PoolLinks.PoolLinks;
    const link = yield* links.resolve(secret);
    if (link === null) return failure(401, "This pool link no longer works.");
    const path = new URL(request.url).pathname.slice(POOL_LINK_PATH.length);
    if (path.startsWith("/v1/")) {
      return yield* engine.modelRequest(link.actor, request, path.slice("/v1".length));
    }
    if (path === "" && request.method === "GET") {
      const info = yield* engine.info(link.actor);
      const { accounts } = yield* engine.accounts(link.actor);
      return Response.json({
        name: info.name,
        accounts: accounts.map(({ name, type, disabled, signedOut }) => ({
          name,
          type,
          disabled,
          signedOut,
        })),
      } satisfies PoolLinkInfo);
    }
    if (path === "/accounts" && request.method === "POST") {
      if (!link.moveOpen) {
        return failure(403, "This pool link no longer takes accounts. Start the move again.");
      }
      const body = yield* Effect.tryPromise(() => request.json()).pipe(
        Effect.flatMap(decodeMoveRequest),
        Effect.option,
      );
      if (body._tag === "None") return failure(400, "That is not a list of accounts.");
      return Response.json(yield* engine.importAccounts(link.actor, body.value.accounts));
    }
    return failure(404, `A pool link does not serve ${request.method} ${path || "/"}.`);
  }).pipe(
    Effect.catchTags({
      PoolRejectedError: (error: PoolEngine.PoolRejectedError) =>
        Effect.succeed(failure(403, error.reason)),
      PoolBackendError: (error: PoolBackendError) =>
        Effect.logWarning("pool link request failed", error.detail, error.cause).pipe(
          Effect.as(failure(502, error.detail)),
        ),
      SqlError: (cause) =>
        Effect.logError("pool link storage failed", { cause }).pipe(
          Effect.as(failure(500, "The pool could not be read. Try again.")),
        ),
    }),
  );
