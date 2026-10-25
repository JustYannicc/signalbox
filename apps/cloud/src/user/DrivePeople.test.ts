import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http";

import * as IdentityProvider from "../account/IdentityProvider.ts";
import * as DrivePeople from "./DrivePeople.ts";

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
  const requests: Array<{ readonly url: string; readonly authorization: string | undefined }> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const query = UrlParams.toString(request.urlParams);
      requests.push({
        url: `${request.url}${query ? `?${query}` : ""}`,
        authorization: request.headers.authorization,
      });
      const body = new URL(request.url).pathname.endsWith("/users")
        ? {
            data: [{ id: "found-user", email: "found@example.com", first_name: "Found" }],
          }
        : {
            data: [{ organization_id: "org-1", organization_name: "Org One" }],
            list_metadata: { after: null },
          };
      return HttpClientResponse.fromWeb(request, Response.json(body, { status: 200 }));
    }),
  );
  const configs = new Map<string, typeof PRIMARY | typeof E2E>([
    ["ordinary-user", PRIMARY],
    ["e2e-user", E2E],
    ["e2e-target", E2E],
    ["ordinary-target", PRIMARY],
  ]);
  const identities = IdentityProvider.IdentityProviders.of({
    identityProviderForUser: (userId) => {
      const config = configs.get(userId);
      return config === undefined
        ? Effect.fail(new IdentityProvider.IdentityProviderUnavailable({}))
        : Effect.succeed(config);
    },
  });
  const layerFor = (callerId: string) =>
    DrivePeople.layerForUser(Effect.succeed(callerId)).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, http),
          Layer.succeed(IdentityProvider.IdentityProviders, identities),
        ),
      ),
    );
  return { requests, layerFor };
};

describe("DrivePeople realm routing", () => {
  it.effect("searches only the caller's WorkOS realm", () =>
    Effect.gen(function* () {
      const { requests, layerFor } = setup();
      for (const callerId of ["ordinary-user", "e2e-user"]) {
        const result = yield* DrivePeople.DrivePeople.use((people) =>
          people.findByEmail("found@example.com"),
        ).pipe(Effect.provide(layerFor(callerId)));
        expect(result?.userId).toBe("found-user");
      }

      expect(
        requests.map((request) => [new URL(request.url).origin, request.authorization]),
      ).toEqual([
        [PRIMARY.apiBaseUrl, `Bearer ${Redacted.value(PRIMARY.apiKey)}`],
        [E2E.apiBaseUrl, `Bearer ${Redacted.value(E2E.apiKey)}`],
      ]);
    }),
  );

  it.effect("refuses unknown caller identities and cross-realm memberships before HTTP", () =>
    Effect.gen(function* () {
      const { requests, layerFor } = setup();
      const unknown = yield* DrivePeople.DrivePeople.use((people) =>
        people.findByEmail("found@example.com"),
      ).pipe(Effect.provide(layerFor("unknown-user")), Effect.flip);
      expect(unknown._tag).toBe("DrivePeopleError");

      const crossRealm = yield* DrivePeople.DrivePeople.use((people) =>
        people.organizationsOf("ordinary-target"),
      ).pipe(Effect.provide(layerFor("e2e-user")), Effect.flip);
      expect(crossRealm._tag).toBe("DrivePeopleError");
      expect(requests).toEqual([]);
    }),
  );

  it.effect("lists memberships only when caller and target share a WorkOS realm", () =>
    Effect.gen(function* () {
      const { requests, layerFor } = setup();
      const organizations = yield* DrivePeople.DrivePeople.use((people) =>
        people.organizationsOf("e2e-target"),
      ).pipe(Effect.provide(layerFor("e2e-user")));

      expect(organizations).toEqual(["org-1"]);
      expect(requests).toEqual([
        {
          url: `${E2E.apiBaseUrl}/user_management/organization_memberships?user_id=e2e-target&statuses=active&limit=100`,
          authorization: `Bearer ${Redacted.value(E2E.apiKey)}`,
        },
      ]);
    }),
  );
});
