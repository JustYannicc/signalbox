import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as WorkOSClient from "./WorkOSClient.ts";
import { workosStubLayer } from "./WorkOSTesting.ts";

const config = {
  clientId: "client_test",
  apiKey: Redacted.make("sk_test"),
  apiBaseUrl: "https://workos.test",
};

describe("WorkOSClient.listOrganizations", () => {
  it.effect("follows the cursor through every page of active memberships", () => {
    const organizations = Array.from({ length: 230 }, (_, index) => ({
      id: `org_${index}`,
      name: `Org ${index}`,
    }));
    return Effect.gen(function* () {
      expect(yield* WorkOSClient.listOrganizations(config, "user_many")).toEqual(organizations);
      expect(yield* WorkOSClient.listOrganizations(config, "user_none")).toEqual([]);
    }).pipe(Effect.provide(workosStubLayer({}, [], { user_many: organizations })));
  });

  it.effect("keeps each membership's role slugs from either response shape", () =>
    Effect.gen(function* () {
      expect(yield* WorkOSClient.listOrganizations(config, "user_roles")).toEqual([
        { id: "org_multi", name: "Multi", roleSlugs: ["admin", "billing"] },
        { id: "org_single", name: "Single", roleSlugs: ["member"] },
        { id: "org_role_only", name: "Role only", roleSlugs: ["admin"] },
        { id: "org_custom", name: "Custom", roleSlugs: ["Admin", "org-admin"] },
        { id: "org_none", name: "None" },
      ]);
    }).pipe(
      Effect.provide(
        workosStubLayer({}, [], {
          user_roles: [
            { id: "org_multi", name: "Multi", roleSlugs: ["billing", "admin", "billing"] },
            { id: "org_single", name: "Single", roleSlugs: ["member"] },
            // Before Multiple Roles, WorkOS sent only `role`.
            { id: "org_role_only", name: "Role only", wire: { role: { slug: "admin" } } },
            { id: "org_custom", name: "Custom", roleSlugs: ["org-admin", "Admin"] },
            { id: "org_none", name: "None" },
          ],
        }),
      ),
    ),
  );

  it.effect("drops malformed roles without failing the listing or granting any", () =>
    Effect.gen(function* () {
      expect(yield* WorkOSClient.listOrganizations(config, "user_bad")).toEqual([
        { id: "org_bad_roles", name: "Bad roles" },
        { id: "org_null_roles", name: "Null roles" },
        { id: "org_bad_both", name: "Bad both" },
        { id: "org_empty_slug", name: "Empty slug" },
        { id: "org_roles_wins", name: "Roles wins" },
      ]);
    }).pipe(
      Effect.provide(
        workosStubLayer({}, [], {
          user_bad: [
            // A malformed `roles` never falls back to a possibly stale `role`.
            {
              id: "org_bad_roles",
              name: "Bad roles",
              wire: { role: { slug: "admin" }, roles: [{ slug: "admin" }, { slug: 7 }] },
            },
            {
              id: "org_null_roles",
              name: "Null roles",
              wire: { role: { slug: "admin" }, roles: null },
            },
            { id: "org_bad_both", name: "Bad both", wire: { role: "admin", roles: "admin" } },
            { id: "org_empty_slug", name: "Empty slug", wire: { role: { slug: "" } } },
            // `roles` lists every role, so an empty one outranks a stray `role`.
            {
              id: "org_roles_wins",
              name: "Roles wins",
              wire: { role: { slug: "admin" }, roles: [] },
            },
          ],
        }),
      ),
    ),
  );

  it.effect("fails rather than return part of the memberships", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(WorkOSClient.listOrganizations(config, "user_many"));
      expect(error._tag).toBe("WorkOSOrganizationsError");
    }).pipe(
      Effect.provide(
        workosStubLayer({}, [], {
          // Past the page cap, so the cursor never runs out.
          user_many: Array.from({ length: 2_100 }, (_, index) => ({
            id: `org_${index}`,
            name: `Org ${index}`,
            roleSlugs: ["admin"],
          })),
        }),
      ),
    ),
  );
});
