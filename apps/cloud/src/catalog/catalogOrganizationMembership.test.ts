import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { catalogHomeKey } from "./catalogHome.ts";
import { catalogOrganizationTables } from "./catalogOrganizationTables.ts";
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

const bootstrap = org.projections.bootstrap.run;
const sync = org.projections.syncMembership.run;
const access = org.views.access.run;
const decodeDelivery = Schema.decodeUnknownSync(org.projections.syncMembership.input);
const decodeMembership = Schema.decodeUnknownSync(catalogOrganizationTables.memberships.row);
const orphan = {
  folders: {
    id: "orphan",
    parentId: null,
    parentIncarnation: 1,
    incarnation: 1,
    name: "orphan",
    position: 0,
    state: "active",
  },
  grants: { folderId: null, incarnation: 1, personId: "ada", role: "Admin" },
  memberships: member("ada", ["admin"]),
} as const;

describe("organization root bootstrap", () => {
  it.effect("initializes once, repeats as a no-op and rejects another incarnation", () =>
    Effect.gen(function* () {
      const context = organizationContext();
      expect(yield* bootstrap(context.projection, { incarnation: 1 })).toEqual({ changed: true });
      expect(context.state.rows()).toEqual([openState()]);
      expect(context.root.rows()).toEqual([freshRoot()]);
      expect(yield* bootstrap(context.projection, { incarnation: 1 })).toEqual({ changed: false });
      yield* invalidState(bootstrap(context.projection, { incarnation: 2 }));
      expect(context.state.rows()).toEqual([openState()]);
      expect(context.fences).toEqual([]);
    }),
  );

  it.effect("never adopts orphaned or partial state", () =>
    Effect.gen(function* () {
      const seeds = [
        { state: [openState()] },
        { root: [freshRoot()] },
        { state: [openState(organizationHome("org_two"))], root: [freshRoot()] },
        ...Object.entries(orphan).map(([table, row]) => ({ [table]: [row] })),
      ];
      for (const seed of seeds) {
        const context = organizationContext(seed);
        yield* invalidState(bootstrap(context.projection, { incarnation: 1 }));
        expect(context.state.rows().length + context.root.rows().length).toBe(
          (seed.state?.length ?? 0) + (seed.root?.length ?? 0),
        );
      }
      // A leftover membership must not regain access through a matching new incarnation.
      const leftover = organizationContext({ memberships: [orphan.memberships] });
      yield* invalidState(bootstrap(leftover.projection, { incarnation: 1 }));
      yield* invalidState(access(leftover.as("ada"), top));
    }),
  );

  it.effect("a retired root stays retired and rejects membership deliveries", () =>
    Effect.gen(function* () {
      const context = organizationContext({
        ...bootstrapped({ state: { storageState: "retired" } }),
        memberships: [member("ada", ["admin"])],
      });
      expect(yield* bootstrap(context.projection, { incarnation: 1 })).toEqual({ changed: false });
      yield* invalidState(sync(context.projection, delivery("ada", 2, null)));
      yield* invalidState(sync(context.projection, delivery("bea", 1, ["member"])));
      expect(context.state.rows()).toEqual([
        openState(organizationHome(), { storageState: "retired" }),
      ]);
      expect(context.memberships.rows()).toEqual([member("ada", ["admin"])]);
      expect(context.fences).toEqual([]);
      yield* denied(access(context.as("ada"), top));
    }),
  );
});

describe("organization membership projection", () => {
  it.effect("requires a bootstrapped root and the current root incarnation", () =>
    Effect.gen(function* () {
      yield* invalidState(sync(organizationContext().projection, delivery("ada", 1, [])));
      const context = organizationContext(bootstrapped());
      yield* invalidState(sync(context.projection, delivery("ada", 1, ["admin"], 2)));
      expect(context.memberships.rows()).toEqual([]);
    }),
  );

  it.effect("ignores stale and replayed deliveries; a conflicting replay is corrupt", () =>
    Effect.gen(function* () {
      const context = organizationContext(bootstrapped());
      yield* sync(context.projection, delivery("ada", 5, ["member", "admin"]));
      const after = { memberships: context.memberships.rows(), root: context.root.rows() };
      for (const late of [delivery("ada", 4, null), delivery("ada", 5, ["admin", "member"])]) {
        expect(yield* sync(context.projection, late)).toEqual({ changed: false });
      }
      yield* invalidState(sync(context.projection, delivery("ada", 5, ["admin"])));
      yield* invalidState(sync(context.projection, delivery("ada", 5, null)));
      expect({ memberships: context.memberships.rows(), root: context.root.rows() }).toEqual(after);
      expect(context.state.rows()[0]?.revision).toBe(1);
    }),
  );

  it.effect("removal keeps a tombstone that an older delivery cannot resurrect", () =>
    Effect.gen(function* () {
      const context = organizationContext(bootstrapped());
      // Removal can arrive before the join it supersedes.
      expect(yield* sync(context.projection, delivery("ada", 3, null))).toEqual({ changed: true });
      expect(context.fences).toEqual([]);
      expect(yield* sync(context.projection, delivery("ada", 2, ["admin"]))).toEqual({
        changed: false,
      });
      expect(context.memberships.rows()).toEqual([member("ada", null, 3)]);
      yield* denied(access(context.as("ada"), top));
    }),
  );

  it.effect("fences only effective role changes, and always records the newer revision", () =>
    Effect.gen(function* () {
      const context = organizationContext(bootstrapped());
      const scope = catalogHomeKey(context.projection.home);
      yield* sync(context.projection, delivery("ada", 1, ["member"]));
      yield* sync(context.projection, delivery("ada", 2, ["member", "reviewer"]));
      expect(context.memberships.rows()).toEqual([member("ada", ["member", "reviewer"], 2)]);
      expect(context.state.rows()[0]?.revision).toBe(2);
      expect(context.fences).toEqual([{ scope, epoch: 1 }]);

      yield* sync(context.projection, delivery("ada", 3, ["owner"]));
      expect(yield* access(context.as("ada"), top)).toEqual({ role: "Admin" });
      yield* sync(context.projection, delivery("ada", 4, ["member"]));
      expect(yield* access(context.as("ada"), top)).toEqual({ role: "Viewer" });
      expect(context.fences).toEqual([1, 2, 3].map((epoch) => ({ scope, epoch })));
      expect(context.root.rows()).toEqual([freshRoot({ authEpoch: 3 })]);
    }),
  );

  it.effect("counter exhaustion fails before any write", () =>
    Effect.gen(function* () {
      for (const extra of [
        { state: { revision: Number.MAX_SAFE_INTEGER } },
        { root: { authEpoch: Number.MAX_SAFE_INTEGER } },
      ]) {
        const context = organizationContext(bootstrapped(extra));
        yield* invalidState(sync(context.projection, delivery("ada", 1, ["member"])));
        expect(context.memberships.rows()).toEqual([]);
        expect(context.fences).toEqual([]);
      }
      // An exhausted epoch still records changes that leave authority alone.
      const context = organizationContext({
        ...bootstrapped({ root: { authEpoch: Number.MAX_SAFE_INTEGER } }),
        memberships: [member("ada", ["member"])],
      });
      expect(yield* sync(context.projection, delivery("ada", 2, ["member", "x"]))).toEqual({
        changed: true,
      });
      expect(context.fences).toEqual([]);
    }),
  );

  it.effect("fails closed on membership rows from another incarnation", () =>
    Effect.gen(function* () {
      const context = organizationContext({
        ...bootstrapped(),
        memberships: [member("ada", ["admin"], 1, 2)],
      });
      yield* invalidState(access(context.as("ada"), top));
      yield* invalidState(sync(context.projection, delivery("ada", 2, null)));
    }),
  );

  it("rejects malformed deliveries and non-canonical stored rows", () => {
    for (const input of [
      delivery("ada", 0, []),
      delivery("ada", 1, [], 0),
      delivery(" ada", 1, []),
      delivery("ada", 1, [" admin"]),
      delivery("ada", Number.MAX_SAFE_INTEGER + 1, []),
    ])
      expect(() => decodeDelivery(input)).toThrow();
    for (const row of [member("ada", ["member", "admin"]), member("ada", ["admin", "admin"])])
      expect(() => decodeMembership(row)).toThrow();
  });
});
