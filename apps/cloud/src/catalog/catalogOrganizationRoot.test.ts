import { describe, expect, it } from "@effect/vitest";
import { FolderId } from "@t3tools/contracts/signalboxFolders";
import * as Effect from "effect/Effect";

import { catalogHomeKey } from "./catalogHome.ts";
import { catalogPersonalRoot } from "./catalogPersonalRoot.ts";
import { organizationContext, organizationHome } from "./tests/organizationContext.ts";
import {
  bootstrapped,
  delivery,
  denied,
  freshRoot,
  invalidState,
  member,
  openState,
  org,
  top,
} from "./tests/organizationFixtures.ts";
import { policyContext } from "./tests/policyContext.ts";

const child = { folderId: FolderId.make("child"), incarnation: 2 };
const childRow = {
  id: "child",
  parentId: null,
  parentIncarnation: 1,
  incarnation: 2,
  name: "child",
  position: 0,
  state: "active",
};
const grant = (target: typeof top | typeof child, personId: string, role: string) => ({
  ...target,
  personId,
  role,
});
const access = org.views.access.run;
const sync = org.projections.syncMembership.run;

describe("organization root policy", () => {
  it.effect("two members share one canonical tree with their membership baselines", () =>
    Effect.gen(function* () {
      const context = organizationContext({
        ...bootstrapped(),
        folders: [childRow],
        memberships: [member("ada", ["member"]), member("bea", ["admin"]), member("cy", ["owner"])],
      });
      expect(yield* access(context.as("ada"), child)).toEqual({ role: "Viewer" });
      expect(yield* access(context.as("bea"), child)).toEqual({ role: "Admin" });
      // Owning the organization is not owning its tree.
      expect(yield* access(context.as("cy"), top)).toEqual({ role: "Admin" });
      expect(catalogHomeKey(context.as("ada").home)).toBe(catalogHomeKey(context.as("bea").home));
    }),
  );

  it.effect("keeps custom role slugs but grants only the Viewer baseline for them", () =>
    Effect.gen(function* () {
      const context = organizationContext(bootstrapped());
      yield* sync(context.projection, delivery("ada", 1, ["reviewer", "member", "reviewer"]));
      expect(context.memberships.rows()).toEqual([member("ada", ["member", "reviewer"])]);
      expect(yield* access(context.as("ada"), top)).toEqual({ role: "Viewer" });
    }),
  );

  it.effect("rejects storage bound to another organization or a legacy copy", () =>
    Effect.gen(function* () {
      const other = organizationContext({
        state: [openState(organizationHome("org_two"))],
        root: [freshRoot()],
        memberships: [member("ada", ["admin"])],
      });
      yield* invalidState(access(other.as("ada"), top));
      yield* invalidState(sync(other.projection, delivery("ada", 2, null)));
      expect(other.memberships.rows()).toEqual([member("ada", ["admin"])]);

      const legacyHome = { ...organizationHome(), legacySource: "ada" };
      const legacy = organizationContext(
        { state: [openState(legacyHome)], root: [freshRoot()], memberships: [member("ada", [])] },
        legacyHome,
      );
      yield* invalidState(access(legacy.as("ada"), top));
      const personal = policyContext("owner");
      yield* invalidState(
        catalogPersonalRoot.views.access.run(
          { ...personal.ctx, home: { ...personal.ctx.home, legacySource: "owner" } },
          top,
        ),
      );
    }),
  );

  it.effect(
    "requires current membership even with a retained direct grant, and rejoin restores it",
    () =>
      Effect.gen(function* () {
        const context = organizationContext({
          ...bootstrapped(),
          folders: [childRow],
          grants: [grant(child, "ada", "Admin"), grant(top, "eve", "Admin")],
          memberships: [member("ada", ["member"])],
        });
        expect(yield* access(context.as("ada"), child)).toEqual({ role: "Admin" });
        yield* denied(access(context.as("eve"), top));

        yield* sync(context.projection, delivery("ada", 2, null));
        yield* denied(access(context.as("ada"), child));
        yield* denied(
          org.changes.setGrant.run(context.as("ada"), {
            target: child,
            personId: "ada",
            role: "Admin",
          }),
        );
        expect(context.grants.rows()).toContainEqual(grant(child, "ada", "Admin"));

        yield* sync(context.projection, delivery("ada", 3, ["member"]));
        expect(yield* access(context.as("ada"), child)).toEqual({ role: "Admin" });
        expect(context.fences.map(({ epoch }) => epoch)).toEqual([1, 2]);
      }),
  );

  it.effect("demoting an admin drops to Viewer unless a stronger direct grant remains", () =>
    Effect.gen(function* () {
      const context = organizationContext({
        ...bootstrapped(),
        folders: [childRow],
        grants: [grant(child, "bea", "Admin"), grant(top, "cy", "Member")],
        memberships: [member("ada", ["admin"]), member("bea", ["admin"]), member("cy", [])],
      });
      yield* sync(context.projection, delivery("ada", 2, ["member"]));
      yield* sync(context.projection, delivery("bea", 2, ["member"]));
      expect(yield* access(context.as("ada"), child)).toEqual({ role: "Viewer" });
      expect(yield* access(context.as("bea"), top)).toEqual({ role: "Viewer" });
      expect(yield* access(context.as("bea"), child)).toEqual({ role: "Admin" });
      // An inherited grant stronger than the baseline adds to it.
      expect(yield* access(context.as("cy"), child)).toEqual({ role: "Member" });
      expect(context.root.rows()[0]?.authEpoch).toBe(2);
    }),
  );

  it.effect("member admins manage grants and topology through the shared operations", () =>
    Effect.gen(function* () {
      const context = organizationContext({
        ...bootstrapped(),
        folders: [childRow],
        memberships: [member("ada", ["member"]), member("bea", ["admin"])],
      });
      yield* denied(
        org.changes.renameFolder.run(context.as("ada"), { target: child, name: "renamed" }),
      );
      expect(
        yield* org.changes.setGrant.run(context.as("bea"), {
          target: child,
          personId: "ada",
          role: "Member",
        }),
      ).toEqual({ changed: true });
      expect(yield* access(context.as("ada"), child)).toEqual({ role: "Member" });
      expect(
        yield* org.changes.renameFolder.run(context.as("bea"), { target: child, name: "renamed" }),
      ).toEqual({ changed: true });
      expect(context.folders.rows()[0]?.name).toBe("renamed");
      expect(context.fences).toEqual([
        { scope: catalogHomeKey(context.projection.home), epoch: 1 },
      ]);
      expect(context.memberships.rows()).toEqual([
        member("ada", ["member"]),
        member("bea", ["admin"]),
      ]);
    }),
  );

  it("exposes membership and bootstrap authority only as trusted projections", () => {
    expect(Object.keys(org.changes).toSorted()).toEqual(["moveFolder", "renameFolder", "setGrant"]);
    expect(Object.keys(org.projections).toSorted()).toEqual(["bootstrap", "syncMembership"]);
    expect(Object.values(org.projections).map(({ kind }) => kind)).toEqual([
      "projection",
      "projection",
    ]);
  });
});
