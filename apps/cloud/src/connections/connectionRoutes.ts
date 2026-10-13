import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { NO_STORE_HEADERS, requestCredentials } from "../http/credentials.ts";
import { guarded, pageUser } from "../http/pageRoutes.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import { signLinkToken, verifyLinkToken } from "./ConnectionLinks.ts";
import { isLinkedProvider } from "./linkedConnections.ts";

/**
 * Connections for tools outside Signalbox, such as Executor:
 *
 * - `GET /api/connections` and `POST /api/connections/:provider/token` answer
 *   a connection link (`Authorization: Bearer sbcl_…`): what the user
 *   connected, and a fresh token for one. Tools ask on every use, so they
 *   never keep a copy, and revoking the link or the account cuts them off.
 * - `/api/connection-links` is where the signed-in user makes, lists and
 *   revokes links, from Signalbox's own pages.
 */

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: NO_STORE_HEADERS });
const failure = (status: number, error: string, message: string) =>
  json({ error, message }, status);

const INTERNAL = failure(500, "internal", "Something went wrong. Try again.");
const INVALID_LINK = failure(401, "invalid_link", "This Signalbox link no longer works.");

/** The link a tool presents, verified before anything wakes the user's object. */
const presentedLink = Effect.gen(function* () {
  const { bearer } = requestCredentials(yield* HttpServerRequest.HttpServerRequest);
  return bearer === undefined ? null : yield* verifyLinkToken(bearer);
});

const linkedConnectionsRoute = HttpRouter.add(
  "GET",
  "/api/connections",
  guarded(
    "linkedConnectionsRoute",
    Effect.gen(function* () {
      const link = yield* presentedLink;
      if (link === null) return INVALID_LINK;
      const answer = yield* (yield* UserDirectory.UserDirectory)
        .forUser(link.userId)
        .linkedConnections(link.secret);
      return answer._tag === "invalid_link"
        ? INVALID_LINK
        : json({ connections: answer.connections });
    }),
    INTERNAL,
  ),
);

const linkedTokenRoute = HttpRouter.add(
  "POST",
  "/api/connections/:provider/token",
  guarded(
    "linkedTokenRoute",
    Effect.gen(function* () {
      const link = yield* presentedLink;
      if (link === null) return INVALID_LINK;
      const provider = (yield* HttpRouter.params).provider ?? "";
      if (!isLinkedProvider(provider)) {
        return failure(404, "unknown_provider", "Signalbox can't connect that service.");
      }
      const answer = yield* (yield* UserDirectory.UserDirectory)
        .forUser(link.userId)
        .linkedToken({ secret: link.secret, provider });
      switch (answer._tag) {
        case "token":
          return json({ token: answer.token, expiresAt: answer.expiresAt });
        case "invalid_link":
          return INVALID_LINK;
        case "not_connected":
          return failure(404, "not_connected", "That account isn't connected in Signalbox.");
        case "unavailable":
          return failure(503, "unavailable", answer.message);
      }
    }),
    INTERNAL,
  ),
);

/** Signalbox's own pages: the signed-in user, or why there isn't one. */
const withPageUser = <E, R>(
  handler: (userId: string) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.flatMap(pageUser, (user) => {
    switch (user._tag) {
      case "user":
        return handler(user.userId);
      case "cross_site":
        return Effect.succeed(failure(403, "forbidden", "Use Signalbox to manage links."));
      case "signed_out":
        return Effect.succeed(failure(401, "unauthorized", "Sign in to Signalbox first."));
    }
  });

const CreateLink = Schema.Struct({ label: Schema.String.check(Schema.isMaxLength(200)) });

const createLinkRoute = HttpRouter.add(
  "POST",
  "/api/connection-links",
  guarded(
    "createLinkRoute",
    withPageUser((userId) =>
      Effect.gen(function* () {
        const body = yield* HttpServerRequest.schemaBodyJson(CreateLink).pipe(Effect.option);
        if (Option.isNone(body)) {
          return failure(
            400,
            "bad_request",
            "Name where the link is used, in 200 characters or less.",
          );
        }
        const created = yield* (yield* UserDirectory.UserDirectory)
          .forUser(userId)
          .createConnectionLink(body.value.label);
        if (created._tag === "limit") {
          return failure(409, "limit", "Revoke a link you no longer use first.");
        }
        return json({ link: yield* signLinkToken(userId, created.secret) }, 201);
      }),
    ),
    INTERNAL,
  ),
);

const listLinksRoute = HttpRouter.add(
  "GET",
  "/api/connection-links",
  guarded(
    "listLinksRoute",
    withPageUser((userId) =>
      Effect.gen(function* () {
        const links = yield* (yield* UserDirectory.UserDirectory).forUser(userId).connectionLinks();
        return json({ links });
      }),
    ),
    INTERNAL,
  ),
);

const revokeLinkRoute = HttpRouter.add(
  "DELETE",
  "/api/connection-links/:id",
  guarded(
    "revokeLinkRoute",
    withPageUser((userId) =>
      Effect.gen(function* () {
        const id = (yield* HttpRouter.params).id ?? "";
        yield* (yield* UserDirectory.UserDirectory).forUser(userId).revokeConnectionLink(id);
        return HttpServerResponse.empty({ status: 204, headers: NO_STORE_HEADERS });
      }),
    ),
    INTERNAL,
  ),
);

export const layer = Layer.mergeAll(
  linkedConnectionsRoute,
  linkedTokenRoute,
  createLinkRoute,
  listLinksRoute,
  revokeLinkRoute,
);
