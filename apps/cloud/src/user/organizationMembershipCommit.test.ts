import type { WorkOSOrganization } from "@signalbox/account/WorkOSClient";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemoryStore } from "../testing.ts";
import * as Outbox from "./organizationMembershipOutbox.ts";
import * as UserContexts from "./UserContexts.ts";

const ACME = SignalboxContextId.make("org_acme");
const GLOBEX = SignalboxContextId.make("org_globex");
const PERSONAL_ORG = SignalboxContextId.make("org_personal");

const acmeAdmin = [{ id: ACME, name: "Acme", roleSlugs: ["admin"] }];
const globexMember = [{ id: GLOBEX, name: "Globex", roleSlugs: ["member"] }];

const services = Effect.gen(function* () {
  const contexts = yield* UserContexts.UserContexts;
  const sql = yield* SqlClient.SqlClient;
  const memberships = Effect.all({
    revision: sql`SELECT revision FROM contexts_state`,
    rows: sql`SELECT id, name, member, role_slugs FROM organizations ORDER BY id`,
  });
  const outbox = Effect.all({
    applied: sql`SELECT sequence FROM organization_membership_outbox_state`,
    rows: sql`SELECT * FROM organization_membership_outbox ORDER BY organization_id`,
  });
  // Memberships an object held before the outbox existed, never fanned out.
  const legacy = (orgs: ReadonlyArray<WorkOSOrganization>) =>
    Effect.forEach(
      orgs,
      (org) => sql`INSERT INTO organizations (id, name, member, role_slugs)
        VALUES (${org.id}, ${org.name}, 1, ${JSON.stringify(org.roleSlugs ?? [])})`,
      { discard: true },
    );
  const pending = Effect.map(Outbox.pending(), (page) => page.memberships);
  return { contexts, sql, memberships, outbox, legacy, pending };
});

describe("organization membership commits", () => {
  it.effect("seeds the outbox on the first accepted refresh, even with nothing to change", () =>
    Effect.gen(function* () {
      const { contexts, memberships, legacy, pending } = yield* services;
      yield* legacy(acmeAdmin);
      const before = yield* memberships;

      const sequence = yield* contexts.reserveOrganizationRefresh;
      expect(yield* contexts.completeOrganizationRefresh(sequence, acmeAdmin)).toBe(true);
      expect(yield* memberships).toEqual(before);
      expect(yield* pending).toEqual([
        { organizationId: ACME, revision: sequence, roleSlugs: ["admin"] },
      ]);
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("never fans out a legacy organization the filtered snapshot leaves out", () =>
    Effect.gen(function* () {
      const { contexts, legacy, pending } = yield* services;
      // Stored before the personal organization was filtered from WorkOS reads.
      yield* legacy([...acmeAdmin, { id: PERSONAL_ORG, name: "Personal" }]);

      const sequence = yield* contexts.reserveOrganizationRefresh;
      yield* contexts.completeOrganizationRefresh(sequence, acmeAdmin);
      // Not queued, and no tombstone either: it was never told anything.
      expect(yield* pending).toEqual([
        { organizationId: ACME, revision: sequence, roleSlugs: ["admin"] },
      ]);
      expect((yield* contexts.membership(PERSONAL_ORG)).membership).toBeNull();
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("leaves the outbox alone when a refresh is refused as stale", () =>
    Effect.gen(function* () {
      const { contexts, outbox } = yield* services;
      const a = yield* contexts.reserveOrganizationRefresh;
      const b = yield* contexts.reserveOrganizationRefresh;
      // B's read never completes; A is retired anyway.
      expect(yield* contexts.completeOrganizationRefresh(a, acmeAdmin)).toBe(false);
      expect((yield* outbox).rows).toEqual([]);

      expect(yield* contexts.completeOrganizationRefresh(b, globexMember)).toBe(true);
      const afterB = yield* outbox;
      expect(yield* contexts.completeOrganizationRefresh(a, acmeAdmin)).toBe(false);
      expect(yield* outbox).toEqual(afterB);
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("leaves the outbox untouched when a membership write fails", () =>
    Effect.gen(function* () {
      const { contexts, sql, memberships, outbox } = yield* services;
      yield* contexts.syncOrganizations(acmeAdmin);
      const before = { memberships: yield* memberships, outbox: yield* outbox };
      yield* sql`CREATE TRIGGER refuse_boom BEFORE INSERT ON organizations
        WHEN NEW.id = 'org_boom' BEGIN SELECT RAISE(ABORT, 'boom'); END`;

      const sequence = yield* contexts.reserveOrganizationRefresh;
      const failed = yield* contexts
        .completeOrganizationRefresh(sequence, [...globexMember, { id: "org_boom", name: "Boom" }])
        .pipe(Effect.flip);
      expect(failed._tag).toBe("SqlError");
      expect({ memberships: yield* memberships, outbox: yield* outbox }).toEqual(before);
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("rolls memberships back with a snapshot the outbox refuses", () =>
    Effect.gen(function* () {
      const { contexts, memberships, outbox } = yield* services;
      const sequence = yield* contexts.reserveOrganizationRefresh;
      yield* contexts.completeOrganizationRefresh(sequence, acmeAdmin);
      const before = { memberships: yield* memberships, outbox: yield* outbox };

      // The same refresh again, reading something else: the memberships it writes must go too.
      const conflicting = yield* contexts
        .completeOrganizationRefresh(sequence, globexMember)
        .pipe(Effect.flip);
      expect(conflicting).toMatchObject({ reason: "conflicting-replay" });
      expect({ memberships: yield* memberships, outbox: yield* outbox }).toEqual(before);

      const ambiguous = yield* contexts
        .syncOrganizations([...globexMember, { id: GLOBEX, name: "Globex", roleSlugs: ["admin"] }])
        .pipe(Effect.flip);
      expect(ambiguous).toMatchObject({ reason: "duplicate-organization" });
      expect({ memberships: yield* memberships, outbox: yield* outbox }).toEqual(before);
      expect((yield* contexts.membership(ACME)).membership?.roleSlugs).toEqual(["admin"]);
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("files a trusted sync under the sequence it reserved", () =>
    Effect.gen(function* () {
      const { contexts, pending } = yield* services;
      const inFlight = yield* contexts.reserveOrganizationRefresh;
      yield* contexts.syncOrganizations(acmeAdmin);
      expect(yield* pending).toEqual([
        { organizationId: ACME, revision: inFlight + 1, roleSlugs: ["admin"] },
      ]);
      // The sync retired the read in flight; it can't reach the outbox either.
      expect(yield* contexts.completeOrganizationRefresh(inFlight, globexMember)).toBe(false);
      expect((yield* pending).map((m) => m.organizationId)).toEqual([ACME]);
      expect(yield* contexts.reserveOrganizationRefresh).toBe(inFlight + 2);
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("keeps delivered roles delivered and undelivered ones at their revision", () =>
    Effect.gen(function* () {
      const { contexts, pending } = yield* services;
      yield* contexts.syncOrganizations([...acmeAdmin, ...globexMember]);
      const [acme] = yield* pending;
      expect(yield* Outbox.acknowledge(ACME, acme?.revision ?? 0)).toBe(true);

      const sequence = yield* contexts.reserveOrganizationRefresh;
      yield* contexts.completeOrganizationRefresh(sequence, [...globexMember, ...acmeAdmin]);
      expect(yield* pending).toEqual([
        { organizationId: GLOBEX, revision: acme?.revision, roleSlugs: ["member"] },
      ]);
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("queues a departure and a rejoin, and a late delivery clears neither", () =>
    Effect.gen(function* () {
      const { contexts, pending } = yield* services;
      yield* contexts.syncOrganizations([...acmeAdmin, ...globexMember]);
      const joined = (yield* pending).find((m) => m.organizationId === ACME)?.revision ?? 0;

      yield* contexts.syncOrganizations(globexMember);
      const left = (yield* pending).find((m) => m.organizationId === ACME);
      expect(left).toEqual({ organizationId: ACME, revision: joined + 1, roleSlugs: null });
      // Delivery of the join finishes only now.
      expect(yield* Outbox.acknowledge(ACME, joined)).toBe(false);

      const rejoin = yield* contexts.reserveOrganizationRefresh;
      yield* contexts.completeOrganizationRefresh(rejoin, [
        { id: ACME, name: "Acme", roleSlugs: ["member"] },
        ...globexMember,
      ]);
      expect(yield* Outbox.acknowledge(ACME, joined + 1)).toBe(false);
      expect((yield* pending).find((m) => m.organizationId === ACME)).toEqual({
        organizationId: ACME,
        revision: rejoin,
        roleSlugs: ["member"],
      });
      expect((yield* contexts.membership(ACME)).membership?.roleSlugs).toEqual(["member"]);
    }).pipe(Effect.provide(layerMemoryStore)),
  );
});
