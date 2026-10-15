import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { isLocalKey, verifyLocalKey } from "../localKeys/LocalKeys.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import type { ApiCredential } from "./apiObject.ts";
import { MCP_PATH } from "./mcpObject.ts";

/**
 * `/mcp` at the Worker. WorkOS AuthKit is the MCP authorization server
 * (https://workos.com/docs/authkit/mcp): this cloud is the protected
 * resource, advertises AuthKit in its metadata, and checks AuthKit's access
 * tokens (issuer, and audience = this cloud's `/mcp`) against AuthKit's JWKS.
 * A personal key works too, for clients configured with a header. Either way
 * the call goes to the person's user object (`mcpObject.ts`) as an agent's.
 *
 * `WORKOS_AUTHKIT_DOMAIN` names the AuthKit (e.g. `example.authkit.app`).
 * Without it, only personal keys work.
 */

export const PROTECTED_RESOURCE_PATHS = new Set([
  "/.well-known/oauth-protected-resource",
  `/.well-known/oauth-protected-resource${MCP_PATH}`,
]);

const authkitIssuer = Config.String("WORKOS_AUTHKIT_DOMAIN").pipe(
  Config.option,
  Config.map(
    Option.flatMap((domain) =>
      domain.trim() === "" ? Option.none() : Option.some(`https://${domain.trim()}`),
    ),
  ),
  Effect.orElseSucceed(() => Option.none<string>()),
);

const resourceOf = (request: Request) => `${new URL(request.url).origin}${MCP_PATH}`;
const metadataUrlOf = (request: Request) =>
  `${new URL(request.url).origin}/.well-known/oauth-protected-resource${MCP_PATH}`;

/** RFC 9728 metadata: where MCP clients get a token for this cloud. */
export const protectedResourceMetadata = (request: Request) =>
  Effect.gen(function* () {
    const issuer = yield* authkitIssuer;
    return Response.json({
      resource: resourceOf(request),
      authorization_servers: Option.toArray(issuer),
      bearer_methods_supported: ["header"],
    });
  });

const unauthorized = (request: Request, description: string) =>
  Response.json(
    { error: "unauthorized", error_description: description },
    {
      status: 401,
      headers: {
        "www-authenticate": `Bearer error="unauthorized", error_description="${description}", resource_metadata="${metadataUrlOf(request)}"`,
      },
    },
  );

/** One key set per AuthKit per isolate; jose refreshes it when keys rotate. */
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const keySetOf = (issuer: string) => {
  const existing = keySets.get(issuer);
  if (existing) return existing;
  const created = createRemoteJWKSet(new URL(`${issuer}/oauth2/jwks`));
  keySets.set(issuer, created);
  return created;
};

/** The person an AuthKit access token names, if it's valid for this cloud's `/mcp`. */
const verifyAuthKitToken = (token: string, request: Request) =>
  Effect.gen(function* () {
    const issuer = yield* authkitIssuer;
    if (Option.isNone(issuer)) return null;
    const verified = yield* Effect.tryPromise(() =>
      jwtVerify(token, keySetOf(issuer.value), {
        issuer: issuer.value,
        audience: resourceOf(request),
      }),
    ).pipe(Effect.option);
    if (Option.isNone(verified)) return null;
    const { sub, sid } = verified.value.payload;
    return typeof sub === "string"
      ? { userId: sub, sid: typeof sid === "string" ? sid : "authkit" }
      : null;
  });

const bearer = (request: Request) =>
  /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]?.trim() ?? null;

/** Answers `/mcp` by handing it to the caller's user object, or says how to sign in. */
export const handleMcpRequest = (request: Request) =>
  Effect.gen(function* () {
    const token = bearer(request);
    if (token === null) return unauthorized(request, "Sign in to use Signalbox's MCP.");
    let target: { readonly userId: string; readonly credential: ApiCredential } | null = null;
    if (isLocalKey(token)) {
      const key = yield* verifyLocalKey(token);
      if (key !== null)
        target = { userId: key.userId, credential: { _tag: "key", secret: key.secret } };
    } else {
      const person = yield* verifyAuthKitToken(token, request);
      if (person !== null) {
        target = {
          userId: person.userId,
          credential: { _tag: "agent", sid: person.sid, scopes: AuthStandardClientScopes },
        };
      }
    }
    if (target === null) return unauthorized(request, "That token isn't valid here.");
    return yield* (yield* UserDirectory.UserDirectory).callApi(
      target.userId,
      request,
      target.credential,
    );
  }).pipe(
    Effect.catchTags({
      UserObjectError: (error) =>
        Effect.logError("mcp request failed", { cause: error }).pipe(
          Effect.as(Response.json({ error: "internal" }, { status: 500 })),
        ),
    }),
  );
