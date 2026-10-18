import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import * as WorkOSOrganizations from "@signalbox/account/WorkOSOrganizations";

const apiKey = "sk_test_personal_org";
const config = { apiKey: Redacted.make(apiKey), apiBaseUrl: "https://workos.test" };
const userId = "user_123";
const externalId = `personal:${userId}`;
const organizationId = "org_personal_123";

interface HttpCall {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const fakeWorkOS = (respond: () => Response | "network-failure") => {
  const calls: Array<HttpCall> = [];
  const client = HttpClient.make((request) => {
    calls.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
    });
    const response = respond();
    return response === "network-failure"
      ? Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, description: "offline" }),
          }),
        )
      : Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });
  return { calls, layer: Layer.succeed(HttpClient.HttpClient, client) };
};

const resolveFailure = (respond: () => Response | "network-failure", user = userId) => {
  const http = fakeWorkOS(respond);
  return Effect.flip(WorkOSOrganizations.resolvePersonalOrganization(config, user)).pipe(
    Effect.provide(http.layer),
  );
};

const expectNoLeak = (
  failure: WorkOSOrganizations.WorkOSPersonalOrganizationError,
  raw: string,
) => {
  for (const rendered of [failure.message, String(failure), JSON.stringify(failure)]) {
    expect(rendered).not.toContain(raw);
    expect(rendered).not.toContain(apiKey);
  }
};

describe("WorkOSOrganizations.resolvePersonalOrganization", () => {
  it.effect("returns the organization WorkOS keeps under the exact external ID", () => {
    const http = fakeWorkOS(() => json({ id: organizationId, external_id: externalId }));
    return Effect.gen(function* () {
      expect(yield* WorkOSOrganizations.resolvePersonalOrganization(config, userId)).toBe(
        organizationId,
      );
      expect(http.calls).toEqual([
        {
          method: "GET",
          url: "https://workos.test/organizations/external_id/personal%3Auser_123",
          authorization: `Bearer ${apiKey}`,
        },
      ]);
    }).pipe(Effect.provide(http.layer));
  });

  it.effect("escapes the external ID into a single path segment", () => {
    const awkwardUser = "user/../x?y#z";
    const http = fakeWorkOS(() =>
      json({ id: organizationId, external_id: `personal:${awkwardUser}` }),
    );
    return Effect.gen(function* () {
      expect(yield* WorkOSOrganizations.resolvePersonalOrganization(config, awkwardUser)).toBe(
        organizationId,
      );
      expect(http.calls.map((call) => call.url)).toEqual([
        "https://workos.test/organizations/external_id/personal%3Auser%2F..%2Fx%3Fy%23z",
      ]);
    }).pipe(Effect.provide(http.layer));
  });

  it.effect("returns null for a 404", () => {
    const http = fakeWorkOS(() => json({ message: "Organization not found" }, 404));
    return Effect.gen(function* () {
      expect(yield* WorkOSOrganizations.resolvePersonalOrganization(config, userId)).toBeNull();
      expect(http.calls).toHaveLength(1);
    }).pipe(Effect.provide(http.layer));
  });

  it.effect("fails without a status when the request never gets a response", () =>
    Effect.gen(function* () {
      const failure = yield* resolveFailure(() => "network-failure");
      expect(failure._tag).toBe("WorkOSPersonalOrganizationError");
      expect(failure.operation).toBe("resolve");
      expect(failure.status).toBeUndefined();
    }),
  );

  it.effect.each([400, 401, 403, 409, 422, 429, 500, 503])(
    "fails on %s without the response body or API key",
    (status) => {
      const raw = `workos-body-secret-${status}`;
      return Effect.gen(function* () {
        const failure = yield* resolveFailure(() => json({ message: raw, code: raw }, status));
        expect(failure.operation).toBe("resolve");
        expect(failure.status).toBe(status);
        expectNoLeak(failure, raw);
      });
    },
  );

  const malformed: ReadonlyArray<readonly [string, () => Response]> = [
    [
      "a non-JSON body",
      () =>
        new Response("<html>raw-response-secret</html>", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ],
    ["a body without an id", () => json({ external_id: externalId, token: "raw-response-secret" })],
    ["a blank id", () => json({ id: "", external_id: externalId, token: "raw-response-secret" })],
    [
      "a whitespace id",
      () => json({ id: "   ", external_id: externalId, token: "raw-response-secret" }),
    ],
    [
      "a padded id",
      () =>
        json({ id: ` ${organizationId} `, external_id: externalId, token: "raw-response-secret" }),
    ],
    [
      "a non-string id",
      () => json({ id: 7, external_id: externalId, token: "raw-response-secret" }),
    ],
    [
      "another user's external ID",
      () =>
        json({
          id: organizationId,
          external_id: "personal:someone_else",
          token: "raw-response-secret",
        }),
    ],
    [
      "a near-miss external ID",
      () =>
        json({ id: organizationId, external_id: `${externalId} `, token: "raw-response-secret" }),
    ],
    ["a missing external ID", () => json({ id: organizationId, token: "raw-response-secret" })],
  ];

  it.effect.each(malformed)("fails on %s without the response body or API key", ([, respond]) =>
    Effect.gen(function* () {
      const failure = yield* resolveFailure(respond);
      expect(failure.operation).toBe("resolve");
      expect(failure.status).toBe(200);
      expectNoLeak(failure, "raw-response-secret");
    }),
  );
});
