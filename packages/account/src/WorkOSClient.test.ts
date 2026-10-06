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
});
