import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as IdentityProvider from "../account/IdentityProvider.ts";
import * as GitHub from "./GitHub.ts";

const PRIMARY = {
  clientId: "client_primary",
  apiKey: Redacted.make("sk_live_primary"),
  apiBaseUrl: "https://primary.workos.test",
} as const;
const E2E = {
  clientId: "client_e2e",
  apiKey: Redacted.make("sk_test_e2e"),
  apiBaseUrl: "https://e2e.workos.test",
} as const;

const setup = () => {
  const requests: Array<{
    readonly method: string;
    readonly url: string;
    readonly authorization: string | undefined;
    readonly body?: unknown;
  }> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const body =
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : undefined;
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        ...(body === undefined ? {} : { body }),
      });
      const response =
        request.method === "DELETE"
          ? new Response(null, { status: 204 })
          : new URL(request.url).pathname.endsWith("/authorize")
            ? Response.json({ url: "https://workos.test/authorize" })
            : Response.json({ active: false, error: "not_installed" });
      return HttpClientResponse.fromWeb(request, response);
    }),
  );
  const identities = IdentityProvider.IdentityProviders.of({
    identityProviderForUser: (userId) => {
      if (userId === "unknown-user" || userId === "known-test-user-without-config") {
        return Effect.fail(new IdentityProvider.IdentityProviderUnavailable({}));
      }
      if (userId === "missing-key-user") {
        return Effect.succeed({
          clientId: "client_missing",
          apiBaseUrl: "https://missing.workos.test",
        });
      }
      return Effect.succeed(userId === "e2e-user" ? E2E : PRIMARY);
    },
  });
  const layer = GitHub.layerForUsers().pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, http),
        Layer.succeed(IdentityProvider.IdentityProviders, identities),
      ),
    ),
  );
  return { requests, layer };
};

describe("GitHub Pipes realm routing", () => {
  it.effect("uses each user's WorkOS API key and base URL for every Pipes operation", () =>
    Effect.gen(function* () {
      const { requests, layer } = setup();

      for (const userId of ["ordinary-user", "e2e-user"]) {
        const pipes = yield* GitHub.GitHub.pipe(
          Effect.flatMap((github) => github.pipesForUser(userId)),
          Effect.flatMap((found) =>
            found === null
              ? Effect.die("the test identity has no Pipes key")
              : Effect.succeed(found),
          ),
          Effect.provide(layer),
        );
        expect(
          yield* pipes.authorizeUrl({ userId, returnTo: "https://signalbox.test/return" }),
        ).toBe("https://workos.test/authorize");
        expect((yield* pipes.accessToken(userId))._tag).toBe("inactive");
        yield* pipes.disconnect(userId);
      }

      expect(
        requests.map((request) => [
          request.method,
          new URL(request.url).origin,
          request.authorization,
        ]),
      ).toEqual([
        ["POST", PRIMARY.apiBaseUrl, `Bearer ${Redacted.value(PRIMARY.apiKey)}`],
        ["POST", PRIMARY.apiBaseUrl, `Bearer ${Redacted.value(PRIMARY.apiKey)}`],
        ["DELETE", PRIMARY.apiBaseUrl, `Bearer ${Redacted.value(PRIMARY.apiKey)}`],
        ["POST", E2E.apiBaseUrl, `Bearer ${Redacted.value(E2E.apiKey)}`],
        ["POST", E2E.apiBaseUrl, `Bearer ${Redacted.value(E2E.apiKey)}`],
        ["DELETE", E2E.apiBaseUrl, `Bearer ${Redacted.value(E2E.apiKey)}`],
      ]);
      expect(requests.map((request) => request.body)).toEqual([
        { user_id: "ordinary-user", return_to: "https://signalbox.test/return" },
        { user_id: "ordinary-user" },
        undefined,
        { user_id: "e2e-user", return_to: "https://signalbox.test/return" },
        { user_id: "e2e-user" },
        undefined,
      ]);
    }),
  );

  it.effect(
    "keeps users without a resolved key unavailable and never falls back after identity failure",
    () =>
      Effect.gen(function* () {
        const { requests, layer } = setup();
        const github = yield* GitHub.GitHub.pipe(Effect.provide(layer));
        const error = yield* github
          .pipesForUser("known-test-user-without-config")
          .pipe(Effect.flip);
        expect(error._tag).toBe("WorkOSPipesError");
        expect(error.status).toBe(0);
        expect(yield* github.pipesForUser("missing-key-user")).toBeNull();
        expect(requests).toEqual([]);
      }),
  );
});
