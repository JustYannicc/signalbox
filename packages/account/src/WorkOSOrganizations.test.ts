import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http";

import * as WorkOSOrganizations from "./WorkOSOrganizations.ts";

const config = {
  apiKey: Redacted.make("sk_test_personal_org"),
  apiBaseUrl: "https://workos.test",
};
const userId = "user_123";
const externalId = `personal:${userId}`;
const organizationId = "org_personal_123";

interface HttpCall {
  readonly method: string;
  readonly url: URL;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const page = (memberships: ReadonlyArray<Record<string, unknown>>) =>
  json({ object: "list", data: memberships, list_metadata: { after: null } });

const capture = (request: Parameters<Parameters<typeof HttpClient.make>[0]>[0]): HttpCall => {
  const query = UrlParams.toString(request.urlParams);
  const url = new URL(query ? `${request.url}?${query}` : request.url);
  const bytes = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array();
  return {
    method: request.method,
    url,
    authorization: request.headers.authorization,
    body: bytes.length === 0 ? undefined : JSON.parse(new TextDecoder().decode(bytes)),
  };
};

const fakeWorkOS = (respond: (call: HttpCall) => Effect.Effect<Response>) => {
  const calls: Array<HttpCall> = [];
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const call = capture(request);
      calls.push(call);
      return HttpClientResponse.fromWeb(request, yield* respond(call));
    }),
  );
  return { calls, layer: Layer.succeed(HttpClient.HttpClient, client) };
};

describe("WorkOSOrganizations.resolvePersonalOrganization", () => {
  it.effect("returns null only for a real external-ID 404", () => {
    const http = fakeWorkOS(() => Effect.succeed(json({ message: "ignored" }, 404)));
    return Effect.gen(function* () {
      expect(yield* WorkOSOrganizations.resolvePersonalOrganization(config, userId)).toBeNull();
      expect(http.calls).toHaveLength(1);
      expect(http.calls[0]?.method).toBe("GET");
      expect(decodeURIComponent(http.calls[0]!.url.pathname)).toBe(
        `/organizations/external_id/${externalId}`,
      );
      expect(http.calls[0]?.authorization).toBe("Bearer sk_test_personal_org");
    }).pipe(Effect.provide(http.layer));
  });

  it.effect("keeps WorkOS error bodies and credentials out of the typed error", () => {
    const secret = "sk_live_do_not_leak";
    const http = fakeWorkOS(() => Effect.succeed(json({ message: secret }, 401)));
    return Effect.gen(function* () {
      const failure = yield* Effect.flip(
        WorkOSOrganizations.resolvePersonalOrganization(config, userId),
      );
      expect(failure._tag).toBe("WorkOSPersonalOrganizationError");
      expect(failure.operation).toBe("resolve");
      expect(failure.status).toBe(401);
      expect(failure.message).not.toContain(secret);
      expect(failure.message).not.toContain("sk_test_personal_org");
    }).pipe(Effect.provide(http.layer));
  });

  it.effect("rejects a successful response that does not match the requested external ID", () => {
    const http = fakeWorkOS(() =>
      Effect.succeed(json({ id: organizationId, external_id: "personal:someone_else" })),
    );
    return Effect.gen(function* () {
      const failure = yield* Effect.flip(
        WorkOSOrganizations.resolvePersonalOrganization(config, userId),
      );
      expect(failure._tag).toBe("WorkOSPersonalOrganizationError");
      expect(failure.status).toBe(200);
    }).pipe(Effect.provide(http.layer));
  });
});

describe("WorkOSOrganizations.ensurePersonalOrganization", () => {
  it.effect("uses the exact external-ID organization and existing active membership", () => {
    const http = fakeWorkOS((call) => {
      if (call.method === "GET" && call.url.pathname.startsWith("/organizations/external_id/")) {
        return Effect.succeed(json({ id: organizationId, external_id: externalId }));
      }
      if (
        call.method === "GET" &&
        call.url.pathname === "/user_management/organization_memberships"
      ) {
        return Effect.succeed(
          page([
            {
              id: "om_1",
              organization_id: organizationId,
              user_id: userId,
              status: "active",
            },
          ]),
        );
      }
      return Effect.die(new Error(`Unexpected request: ${call.method} ${call.url.pathname}`));
    });

    return Effect.gen(function* () {
      expect(yield* WorkOSOrganizations.ensurePersonalOrganization(config, userId)).toBe(
        organizationId,
      );
      expect(http.calls.map((call) => call.method)).toEqual(["GET", "GET"]);
      const membershipList = http.calls[1]!;
      expect(membershipList.url.searchParams.get("organization_id")).toBe(organizationId);
      expect(membershipList.url.searchParams.get("user_id")).toBe(userId);
      expect(membershipList.url.searchParams.get("statuses")).toBe("active");
    }).pipe(Effect.provide(http.layer));
  });

  it.effect("creates the organization with its external ID, then creates active membership", () => {
    let organizationCreated = false;
    let membershipCreated = false;
    const http = fakeWorkOS((call) => {
      if (call.method === "GET" && call.url.pathname.startsWith("/organizations/external_id/")) {
        return Effect.succeed(
          organizationCreated
            ? json({ id: organizationId, external_id: externalId })
            : json({ message: "missing" }, 404),
        );
      }
      if (call.method === "POST" && call.url.pathname === "/organizations") {
        organizationCreated = true;
        return Effect.succeed(json({ id: organizationId, external_id: externalId }, 201));
      }
      if (
        call.method === "GET" &&
        call.url.pathname === "/user_management/organization_memberships"
      ) {
        return Effect.succeed(
          page(
            membershipCreated
              ? [
                  {
                    id: "om_1",
                    organization_id: organizationId,
                    user_id: userId,
                    status: "active",
                  },
                ]
              : [],
          ),
        );
      }
      if (
        call.method === "POST" &&
        call.url.pathname === "/user_management/organization_memberships"
      ) {
        membershipCreated = true;
        return Effect.succeed(
          json(
            {
              object: "organization_membership",
              id: "om_1",
              organization_id: organizationId,
              user_id: userId,
              status: "active",
            },
            201,
          ),
        );
      }
      return Effect.die(new Error(`Unexpected request: ${call.method} ${call.url.pathname}`));
    });

    return Effect.gen(function* () {
      expect(yield* WorkOSOrganizations.ensurePersonalOrganization(config, userId)).toBe(
        organizationId,
      );
      const createOrganization = http.calls.find(
        (call) => call.method === "POST" && call.url.pathname === "/organizations",
      );
      expect(createOrganization?.body).toEqual({ name: "Personal", external_id: externalId });
      const list = http.calls.find(
        (call) =>
          call.method === "GET" &&
          call.url.pathname === "/user_management/organization_memberships",
      );
      expect(list?.url.searchParams.get("organization_id")).toBe(organizationId);
      expect(list?.url.searchParams.get("user_id")).toBe(userId);
      expect(list?.url.searchParams.get("statuses")).toBe("active");
      const createMembership = http.calls.find(
        (call) =>
          call.method === "POST" &&
          call.url.pathname === "/user_management/organization_memberships",
      );
      expect(createMembership?.body).toEqual({ organization_id: organizationId, user_id: userId });
    }).pipe(Effect.provide(http.layer));
  });

  it.effect(
    "converges concurrent organization and membership creates through authoritative reads",
    () => {
      let organization: { readonly id: string; readonly external_id: string } | null = null;
      let activeMembership = false;
      let organizationReadCount = 0;
      let membershipReadCount = 0;
      let releaseOrganizationReads = () => {};
      let releaseMembershipReads = () => {};
      const bothOrganizationReads = new Promise<void>((resolve) => {
        releaseOrganizationReads = resolve;
      });
      const bothMembershipReads = new Promise<void>((resolve) => {
        releaseMembershipReads = resolve;
      });

      const http = fakeWorkOS((call) => {
        if (call.method === "GET" && call.url.pathname.startsWith("/organizations/external_id/")) {
          if (!organization && organizationReadCount < 2) {
            organizationReadCount++;
            if (organizationReadCount === 2) releaseOrganizationReads();
            return Effect.promise(() => bothOrganizationReads).pipe(
              Effect.as(json({ message: "missing" }, 404)),
            );
          }
          return Effect.succeed(
            organization ? json(organization) : json({ message: "missing" }, 404),
          );
        }
        if (call.method === "POST" && call.url.pathname === "/organizations") {
          if (organization) return Effect.succeed(json({ message: "duplicate" }, 409));
          organization = { id: organizationId, external_id: externalId };
          return Effect.succeed(json(organization, 201));
        }
        if (
          call.method === "GET" &&
          call.url.pathname === "/user_management/organization_memberships"
        ) {
          if (!activeMembership && membershipReadCount < 2) {
            membershipReadCount++;
            if (membershipReadCount === 2) releaseMembershipReads();
            return Effect.promise(() => bothMembershipReads).pipe(Effect.as(page([])));
          }
          return Effect.succeed(
            page(
              activeMembership
                ? [
                    {
                      id: "om_1",
                      organization_id: organizationId,
                      user_id: userId,
                      status: "active",
                    },
                  ]
                : [],
            ),
          );
        }
        if (
          call.method === "POST" &&
          call.url.pathname === "/user_management/organization_memberships"
        ) {
          if (activeMembership) return Effect.succeed(json({ message: "duplicate" }, 409));
          activeMembership = true;
          return Effect.succeed(
            json(
              {
                object: "organization_membership",
                id: "om_1",
                organization_id: organizationId,
                user_id: userId,
                status: "active",
              },
              201,
            ),
          );
        }
        return Effect.die(new Error(`Unexpected request: ${call.method} ${call.url.pathname}`));
      });

      return Effect.gen(function* () {
        const ids = yield* Effect.all(
          [
            WorkOSOrganizations.ensurePersonalOrganization(config, userId),
            WorkOSOrganizations.ensurePersonalOrganization(config, userId),
          ],
          { concurrency: 2 },
        );
        expect(ids).toEqual([organizationId, organizationId]);
        expect(
          http.calls.filter(
            (call) => call.method === "POST" && call.url.pathname === "/organizations",
          ),
        ).toHaveLength(2);
        expect(
          http.calls.filter(
            (call) =>
              call.method === "POST" &&
              call.url.pathname === "/user_management/organization_memberships",
          ),
        ).toHaveLength(2);
        expect(
          http.calls.filter(
            (call) =>
              call.method === "GET" && call.url.pathname.startsWith("/organizations/external_id/"),
          ).length,
        ).toBeGreaterThanOrEqual(3);
      }).pipe(Effect.provide(http.layer));
    },
  );

  it.effect("returns a safe typed error for malformed successful responses", () => {
    const http = fakeWorkOS(() => Effect.succeed(json({ access_token: "secret-response-token" })));
    return Effect.gen(function* () {
      const failure = yield* Effect.flip(
        WorkOSOrganizations.ensurePersonalOrganization(config, userId),
      );
      expect(failure._tag).toBe("WorkOSPersonalOrganizationError");
      expect(failure.message).not.toContain("secret-response-token");
      expect(failure.operation).toBe("resolve");
    }).pipe(Effect.provide(http.layer));
  });
});
