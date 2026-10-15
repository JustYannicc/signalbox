import { MODEL_GATEWAY_PATHS } from "@signalbox/runner-protocol/RunnerProtocol";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { NO_STORE_HEADERS, requestUrl } from "../http/credentials.ts";
import { LOCAL_KEY_HEADER } from "../modelGateway/modelGateway.ts";
import {
  guarded,
  pageFailure,
  pageJson,
  withPageUser as sharedWithPageUser,
} from "../http/pageRoutes.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import { LOCAL_KEY_PREFIX, signLocalKey } from "./LocalKeys.ts";
import { setupScript } from "./localSetup.ts";

/**
 * Local keys over HTTP, from Signalbox's own pages:
 *
 * - `/api/local-keys` makes, lists and revokes the signed-in user's keys.
 *   Making one answers the one command that sets a computer up with it.
 * - `GET /api/local-keys/setup` is that command's script (`localSetup.ts`),
 *   public like any installer: it holds no key.
 */

export const SETUP_PATH = "/api/local-keys/setup";

const json = pageJson;
const failure = pageFailure;

const INTERNAL = failure(500, "internal", "Something went wrong. Try again.");

/** Where the cloud's harnesses send model requests; local ones use the same. */
const gatewayUrl = Effect.gen(function* () {
  const url = yield* Config.String("MODEL_GATEWAY_URL").pipe(Config.option);
  return Option.filter(
    Option.map(url, (value) => value.trim()),
    (value) => value !== "",
  );
}).pipe(Effect.orElseSucceed(() => Option.none<string>()));

const setupUrl = Effect.map(requestUrl, (url) => new URL(SETUP_PATH, url).href);

const withPageUser = sharedWithPageUser("Use Signalbox to manage keys.");

const CreateKey = Schema.Struct({ label: Schema.String.check(Schema.isMaxLength(200)) });

const createKeyRoute = HttpRouter.add(
  "POST",
  "/api/local-keys",
  guarded(
    "createLocalKeyRoute",
    withPageUser((userId) =>
      Effect.gen(function* () {
        if (Option.isNone(yield* gatewayUrl)) {
          return failure(404, "unavailable", "This Signalbox has no model gateway.");
        }
        const body = yield* HttpServerRequest.schemaBodyJson(CreateKey).pipe(Effect.option);
        if (Option.isNone(body)) {
          return failure(400, "bad_request", "Name the computer in 200 characters or less.");
        }
        const created = yield* (yield* UserDirectory.UserDirectory)
          .forUser(userId)
          .createLocalKey(body.value.label);
        if (created._tag === "limit") {
          return failure(409, "limit", "Revoke a key you no longer use first.");
        }
        const key = yield* signLocalKey(userId, created.secret);
        return json({ key, command: `curl -fsSL ${yield* setupUrl} | node - ${key}` }, 201);
      }),
    ),
    INTERNAL,
  ),
);

const listKeysRoute = HttpRouter.add(
  "GET",
  "/api/local-keys",
  guarded(
    "listLocalKeysRoute",
    withPageUser((userId) =>
      Effect.gen(function* () {
        const view = yield* (yield* UserDirectory.UserDirectory).forUser(userId).localKeys();
        return json({ ...view, available: Option.isSome(yield* gatewayUrl) });
      }),
    ),
    INTERNAL,
  ),
);

const revokeKeyRoute = HttpRouter.add(
  "DELETE",
  "/api/local-keys/:id",
  guarded(
    "revokeLocalKeyRoute",
    withPageUser((userId) =>
      Effect.gen(function* () {
        const id = (yield* HttpRouter.params).id ?? "";
        yield* (yield* UserDirectory.UserDirectory).forUser(userId).revokeLocalKey(id);
        return HttpServerResponse.empty({ status: 204, headers: NO_STORE_HEADERS });
      }),
    ),
    INTERNAL,
  ),
);

const setupRoute = HttpRouter.add(
  "GET",
  SETUP_PATH,
  Effect.gen(function* () {
    const gateway = yield* gatewayUrl;
    if (Option.isNone(gateway)) return HttpServerResponse.text("", { status: 404 });
    const origin = gateway.value.replace(/\/+$/, "");
    const script = setupScript({
      setupUrl: yield* setupUrl,
      anthropicUrl: `${origin}${MODEL_GATEWAY_PATHS.anthropic}`,
      openaiUrl: `${origin}${MODEL_GATEWAY_PATHS.openai}/v1`,
      keyPrefix: LOCAL_KEY_PREFIX,
      keyHeader: LOCAL_KEY_HEADER,
    });
    return HttpServerResponse.text(script, {
      contentType: "text/javascript; charset=utf-8",
      headers: NO_STORE_HEADERS,
    });
  }),
);

export const layer = Layer.mergeAll(setupRoute, createKeyRoute, listKeysRoute, revokeKeyRoute);
