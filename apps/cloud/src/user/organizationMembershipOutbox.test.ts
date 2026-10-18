import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemoryStore } from "../testing.ts";
import * as Outbox from "./organizationMembershipOutbox.ts";
import * as UserStore from "./UserStore.ts";

const ACME = "org_acme";
const GLOBEX = "org_globex";

const services = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Everything the outbox owns, so a refused snapshot is shown to write nothing.
  const state = Effect.all({
    rows: sql`SELECT * FROM organization_membership_outbox ORDER BY organization_id`,
    applied: sql`SELECT sequence FROM organization_membership_outbox_state`,
  });
  const pendingOf = (organizationId: string) =>
    Effect.map(
      Outbox.pending(),
      (page) => page.memberships.find((m) => m.organizationId === organizationId) ?? null,
    );
  return { sql, state, pendingOf };
});

describe("organization membership outbox", () => {
  it.effect("queues each new organization with roles normalized like UserContexts", () =>
    Effect.gen(function* () {
      yield* services;
      expect(
        yield* Outbox.syncSnapshot(1, [
          { id: ACME, name: "Acme", roleSlugs: ["member", "admin", "", "admin"] },
          // Custom slugs stay verbatim; nothing reads them as admin.
          { id: GLOBEX, name: "Globex", roleSlugs: ["org-admin", "Admin"] },
          { id: "org_plain", name: "Plain" },
        ]),
      ).toBe("applied");
      expect(yield* Outbox.pending()).toEqual({
        memberships: [
          { organizationId: ACME, revision: 1, roleSlugs: ["admin", "member"] },
          { organizationId: GLOBEX, revision: 1, roleSlugs: ["Admin", "org-admin"] },
          { organizationId: "org_plain", revision: 1, roleSlugs: [] },
        ],
        next: null,
      });
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("accepts a repeat of the same snapshot and refuses a conflicting one whole", () =>
    Effect.gen(function* () {
      const { sql, state } = yield* services;
      yield* Outbox.syncSnapshot(2, [
        { id: ACME, name: "Acme", roleSlugs: ["admin", "billing"] },
        { id: GLOBEX, name: "Globex" },
      ]);
      const before = yield* state;

      // Same memberships, reordered and repeated, and a renamed organization.
      expect(
        yield* Outbox.syncSnapshot(2, [
          { id: GLOBEX, name: "Globex Corp", roleSlugs: [] },
          { id: ACME, name: "Acme", roleSlugs: ["billing", "admin", "billing"] },
        ]),
      ).toBe("replayed");
      expect(yield* state).toEqual(before);

      for (const conflicting of [
        [
          { id: ACME, name: "Acme", roleSlugs: ["member"] },
          { id: GLOBEX, name: "Globex" },
        ],
        [{ id: ACME, name: "Acme", roleSlugs: ["admin", "billing"] }],
        [
          { id: ACME, name: "Acme", roleSlugs: ["admin", "billing"] },
          { id: GLOBEX, name: "Globex" },
          { id: "org_new", name: "New" },
        ],
      ]) {
        const refused = yield* sql
          .withTransaction(Outbox.syncSnapshot(2, conflicting))
          .pipe(Effect.flip);
        expect(refused).toMatchObject({
          _tag: "OrganizationMembershipSnapshotError",
          reason: "conflicting-replay",
        });
        expect(yield* state).toEqual(before);
      }
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("ignores a snapshot older than one already applied", () =>
    Effect.gen(function* () {
      const { state } = yield* services;
      yield* Outbox.syncSnapshot(5, [{ id: ACME, name: "Acme", roleSlugs: ["member"] }]);
      const before = yield* state;

      // An older read: different roles, an organization 5 no longer lists, one 5 never had.
      expect(
        yield* Outbox.syncSnapshot(3, [
          { id: ACME, name: "Acme", roleSlugs: ["admin"] },
          { id: GLOBEX, name: "Globex" },
        ]),
      ).toBe("stale");
      expect(yield* Outbox.syncSnapshot(4, [])).toBe("stale");
      expect(yield* state).toEqual(before);
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("keeps an undelivered revision while roles stay the same", () =>
    Effect.gen(function* () {
      const { pendingOf } = yield* services;
      yield* Outbox.syncSnapshot(1, [{ id: ACME, name: "Acme", roleSlugs: ["admin"] }]);
      yield* Outbox.syncSnapshot(2, [{ id: ACME, name: "Acme", roleSlugs: ["admin"] }]);
      expect((yield* pendingOf(ACME))?.revision).toBe(1);
      expect(yield* Outbox.acknowledge(ACME, 1)).toBe(true);
      expect(yield* pendingOf(ACME)).toBeNull();

      // Delivered and unchanged: nothing to queue again.
      yield* Outbox.syncSnapshot(3, [{ id: ACME, name: "Acme", roleSlugs: ["admin"] }]);
      expect(yield* pendingOf(ACME)).toBeNull();
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("leaves a newer change pending when an older delivery acknowledges late", () =>
    Effect.gen(function* () {
      const { pendingOf } = yield* services;
      yield* Outbox.syncSnapshot(1, [{ id: ACME, name: "Acme", roleSlugs: ["admin"] }]);
      expect((yield* pendingOf(ACME))?.revision).toBe(1);
      // The person is demoted while revision 1 is on its way.
      yield* Outbox.syncSnapshot(2, [{ id: ACME, name: "Acme", roleSlugs: ["member"] }]);

      expect(yield* Outbox.acknowledge(ACME, 1)).toBe(false);
      expect(yield* pendingOf(ACME)).toEqual({
        organizationId: ACME,
        revision: 2,
        roleSlugs: ["member"],
      });
      expect(yield* Outbox.acknowledge(ACME, 2)).toBe(true);
      expect(yield* Outbox.acknowledge(ACME, 2)).toBe(false);
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("tombstones a departure once, keeps it after delivery, and rejoins newer", () =>
    Effect.gen(function* () {
      const { sql, pendingOf } = yield* services;
      yield* Outbox.syncSnapshot(1, [
        { id: ACME, name: "Acme", roleSlugs: ["admin"] },
        { id: GLOBEX, name: "Globex" },
      ]);
      yield* Outbox.acknowledge(ACME, 1);
      yield* Outbox.acknowledge(GLOBEX, 1);

      yield* Outbox.syncSnapshot(2, [{ id: GLOBEX, name: "Globex" }]);
      expect(yield* pendingOf(ACME)).toEqual({
        organizationId: ACME,
        revision: 2,
        roleSlugs: null,
      });
      expect(yield* pendingOf(GLOBEX)).toBeNull();

      // Still gone: the tombstone isn't requeued.
      yield* Outbox.syncSnapshot(3, [{ id: GLOBEX, name: "Globex" }]);
      expect((yield* pendingOf(ACME))?.revision).toBe(2);
      expect(yield* Outbox.acknowledge(ACME, 2)).toBe(true);
      expect(
        yield* sql`SELECT revision, role_slugs, pending FROM organization_membership_outbox
          WHERE organization_id = ${ACME}`,
      ).toEqual([{ revision: 2, role_slugs: null, pending: 0 }]);

      yield* Outbox.syncSnapshot(4, [
        { id: ACME, name: "Acme", roleSlugs: ["member"] },
        { id: GLOBEX, name: "Globex" },
      ]);
      expect(yield* pendingOf(ACME)).toEqual({
        organizationId: ACME,
        revision: 4,
        roleSlugs: ["member"],
      });
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("pages every pending membership once, even while deliveries acknowledge", () =>
    Effect.gen(function* () {
      yield* services;
      const ids = Array.from({ length: 250 }, (_, i) => `org_${String(i).padStart(3, "0")}`);
      yield* Outbox.syncSnapshot(
        1,
        ids.map((id) => ({ id, name: id })),
      );
      // Every row departs: the snapshot pages through rows it rewrites.
      yield* Outbox.syncSnapshot(2, []);

      expect((yield* Outbox.pending({ limit: 1000 })).memberships).toHaveLength(100);
      const seen: Array<string> = [];
      let after: string | undefined;
      do {
        const page = yield* Outbox.pending({ after, limit: 7 });
        for (const membership of page.memberships) {
          expect(membership).toMatchObject({ revision: 2, roleSlugs: null });
          seen.push(membership.organizationId);
          yield* Outbox.acknowledge(membership.organizationId, membership.revision);
        }
        after = page.next ?? undefined;
      } while (after !== undefined);
      expect(seen).toEqual(ids);
      expect((yield* Outbox.pending()).memberships).toEqual([]);
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("refuses sequences no revision can hold, and ambiguous organizations", () =>
    Effect.gen(function* () {
      const { state } = yield* services;
      const before = yield* state;
      for (const sequence of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
        const refused = yield* Outbox.syncSnapshot(sequence, []).pipe(Effect.flip);
        expect(refused).toMatchObject({ reason: "invalid-sequence" });
      }
      const duplicate = yield* Outbox.syncSnapshot(1, [
        { id: ACME, name: "Acme", roleSlugs: ["admin"] },
        { id: ACME, name: "Acme", roleSlugs: ["member"] },
      ]).pipe(Effect.flip);
      expect(duplicate).toMatchObject({ reason: "duplicate-organization" });
      const blank = yield* Outbox.syncSnapshot(1, [{ id: " ", name: "Blank" }]).pipe(Effect.flip);
      expect(blank).toMatchObject({ reason: "invalid-organization" });
      expect(yield* state).toEqual(before);

      expect(
        yield* Outbox.syncSnapshot(Number.MAX_SAFE_INTEGER, [
          { id: ACME, name: "Acme" },
          { id: ACME, name: "Acme", roleSlugs: [] },
        ]),
      ).toBe("applied");
      expect(yield* Outbox.acknowledge(ACME, Number.MAX_SAFE_INTEGER + 1)).toBe(false);
      expect(yield* Outbox.acknowledge(ACME, Number.MAX_SAFE_INTEGER)).toBe(true);
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("keeps the outbox across a repeated migration, and starts older objects empty", () =>
    Effect.gen(function* () {
      const { sql, state } = yield* services;
      yield* Outbox.syncSnapshot(1, [{ id: ACME, name: "Acme" }]);
      const before = yield* state;
      expect(yield* UserStore.migrate).toEqual([]);
      expect(yield* state).toEqual(before);

      // A user object from before `0027`.
      yield* sql`DROP TABLE organization_membership_outbox`;
      yield* sql`DROP TABLE organization_membership_outbox_state`;
      yield* sql`DELETE FROM effect_sql_migrations
        WHERE migration_id = 27 AND name = 'organization_membership_outbox'`;
      expect(yield* UserStore.migrate).toEqual([[27, "organization_membership_outbox"]]);
      expect(yield* Outbox.pending()).toEqual({ memberships: [], next: null });
      expect(yield* Outbox.syncSnapshot(1, [{ id: ACME, name: "Acme" }])).toBe("applied");
    }).pipe(Effect.provide(layerMemoryStore)),
  );
});
