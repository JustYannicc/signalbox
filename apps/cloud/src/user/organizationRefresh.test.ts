import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemoryStore } from "../testing.ts";
import * as UserContexts from "./UserContexts.ts";
import * as UserStore from "./UserStore.ts";

const ACME = SignalboxContextId.make("org_acme");
const GLOBEX = SignalboxContextId.make("org_globex");

const acmeAdmin = [{ id: ACME, name: "Acme", roleSlugs: ["admin"] }];
const globexMember = [{ id: GLOBEX, name: "Globex", roleSlugs: ["member"] }];

const services = Effect.gen(function* () {
  const contexts = yield* UserContexts.UserContexts;
  const sql = yield* SqlClient.SqlClient;
  // Everything a refresh may touch, so a refused one is shown to write nothing.
  const state = Effect.all({
    revision: contexts.revision,
    rows: sql`SELECT id, name, member, role_slugs FROM organizations ORDER BY id`,
  });
  return { contexts, sql, state };
});

describe("organization refresh ordering", () => {
  it.effect("refuses an older read that finishes after a newer one", () =>
    Effect.gen(function* () {
      const { contexts, state } = yield* services;
      const a = yield* contexts.reserveOrganizationRefresh;
      const b = yield* contexts.reserveOrganizationRefresh;
      expect(b).toBeGreaterThan(a);

      expect(yield* contexts.completeOrganizationRefresh(b, globexMember)).toBe(true);
      const afterB = yield* state;
      expect(yield* contexts.completeOrganizationRefresh(a, acmeAdmin)).toBe(false);
      expect(yield* state).toEqual(afterB);
      expect((yield* contexts.membership(ACME)).membership).toBeNull();
      expect((yield* contexts.membership(GLOBEX)).membership?.roleSlugs).toEqual(["member"]);
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect(
    "accepts an unchanged newest snapshot without writing, and still retires older reads",
    () =>
      Effect.gen(function* () {
        const { contexts, state } = yield* services;
        yield* contexts.syncOrganizations(acmeAdmin);
        const before = yield* state;

        const a = yield* contexts.reserveOrganizationRefresh;
        const b = yield* contexts.reserveOrganizationRefresh;
        expect(yield* contexts.completeOrganizationRefresh(b, acmeAdmin)).toBe(true);
        // Repeating the newest one is just as harmless.
        expect(yield* contexts.completeOrganizationRefresh(b, acmeAdmin)).toBe(true);
        expect(yield* state).toEqual(before);

        expect(yield* contexts.completeOrganizationRefresh(a, [])).toBe(false);
        expect(yield* state).toEqual(before);
      }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("keeps the prior memberships when the newest read never completes", () =>
    Effect.gen(function* () {
      const { contexts, state } = yield* services;
      yield* contexts.syncOrganizations(acmeAdmin);
      const before = yield* state;

      const a = yield* contexts.reserveOrganizationRefresh;
      // B reserved, then its WorkOS read failed: it never completes.
      yield* contexts.reserveOrganizationRefresh;
      expect(yield* contexts.completeOrganizationRefresh(a, globexMember)).toBe(false);
      expect(yield* state).toEqual(before);
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("lets a trusted sync retire refreshes still in flight", () =>
    Effect.gen(function* () {
      const { contexts } = yield* services;
      const a = yield* contexts.reserveOrganizationRefresh;
      yield* contexts.syncOrganizations(globexMember);
      expect(yield* contexts.completeOrganizationRefresh(a, acmeAdmin)).toBe(false);
      expect((yield* contexts.membership(ACME)).membership).toBeNull();
      expect(yield* contexts.reserveOrganizationRefresh).toBeGreaterThan(a + 1);
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("rolls a failed completion back whole, leaving its reservation current", () =>
    Effect.gen(function* () {
      const { contexts, sql, state } = yield* services;
      yield* contexts.syncOrganizations(acmeAdmin);
      const before = yield* state;
      yield* sql`CREATE TRIGGER refuse_boom BEFORE INSERT ON organizations
        WHEN NEW.id = 'org_boom' BEGIN SELECT RAISE(ABORT, 'boom'); END`;

      const a = yield* contexts.reserveOrganizationRefresh;
      // Clearing memberships runs before the failing insert; it must not survive.
      const failed = yield* contexts
        .completeOrganizationRefresh(a, [...globexMember, { id: "org_boom", name: "Boom" }])
        .pipe(Effect.flip);
      expect(failed._tag).toBe("SqlError");
      expect(yield* state).toEqual(before);
      expect(yield* contexts.completeOrganizationRefresh(a, globexMember)).toBe(true);
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("keeps the sequence across a restarted object and a repeated migration", () =>
    Effect.gen(function* () {
      const { contexts } = yield* services;
      const a = yield* contexts.reserveOrganizationRefresh;
      const b = yield* contexts.reserveOrganizationRefresh;

      yield* UserStore.migrate;
      const restarted = Context.get(
        yield* Layer.build(UserContexts.layerWithDrives),
        UserContexts.UserContexts,
      );
      expect(yield* restarted.completeOrganizationRefresh(a, acmeAdmin)).toBe(false);
      expect(yield* restarted.reserveOrganizationRefresh).toBe(b + 1);
    }).pipe(Effect.scoped, Effect.provide(layerMemoryStore)),
  );

  it.effect("starts objects from before refreshes at the first sequence", () =>
    Effect.gen(function* () {
      const { contexts, sql } = yield* services;
      yield* contexts.syncOrganizations(acmeAdmin);
      // A user object from before `0026`.
      yield* sql`DROP TABLE organization_refresh`;
      yield* sql`DELETE FROM effect_sql_migrations
        WHERE migration_id = 26 AND name = 'organization_refresh'`;

      yield* UserStore.migrate;
      expect(yield* contexts.reserveOrganizationRefresh).toBe(1);
      expect((yield* contexts.membership(ACME)).membership?.roleSlugs).toEqual(["admin"]);
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("refuses to reserve past the largest safe sequence", () =>
    Effect.gen(function* () {
      const { contexts, sql } = yield* services;
      yield* sql`UPDATE organization_refresh SET sequence = ${Number.MAX_SAFE_INTEGER - 1}`;
      const last = yield* contexts.reserveOrganizationRefresh;
      expect(last).toBe(Number.MAX_SAFE_INTEGER);

      const exhausted = yield* contexts.reserveOrganizationRefresh.pipe(Effect.flip);
      expect(exhausted._tag).toBe("OrganizationRefreshExhaustedError");
      expect(yield* contexts.completeOrganizationRefresh(last, acmeAdmin)).toBe(true);
      // Nothing out of range ever matches.
      expect(yield* contexts.completeOrganizationRefresh(last + 1, [])).toBe(false);
      expect(yield* contexts.completeOrganizationRefresh(0, [])).toBe(false);
    }).pipe(Effect.provide(layerMemoryStore)),
  );
});
