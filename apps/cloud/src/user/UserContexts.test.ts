import { PERSONAL_CONTEXT_ID, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemoryStore } from "../testing.ts";
import * as UserContexts from "./UserContexts.ts";
import * as UserStore from "./UserStore.ts";

const ACME = SignalboxContextId.make("org_acme");
const GLOBEX = SignalboxContextId.make("org_globex");

const services = Effect.gen(function* () {
  const contexts = yield* UserContexts.UserContexts;
  const sql = yield* SqlClient.SqlClient;
  return { contexts, sql };
});

describe("UserContexts memberships", () => {
  it.effect("keeps role slugs verbatim, out of the contexts clients see", () =>
    Effect.gen(function* () {
      const { contexts } = yield* services;
      yield* contexts.syncOrganizations([
        { id: ACME, name: "Acme", roleSlugs: ["member", "admin", "admin"] },
        // Custom slugs stay as they are; nothing reads them as admin.
        { id: GLOBEX, name: "Globex", roleSlugs: ["org-admin", "Admin"] },
        { id: "org_plain", name: "Plain" },
      ]);
      const { revision } = yield* contexts.membership(ACME);
      expect(revision).toBeGreaterThan(0);
      expect(yield* contexts.membership(ACME)).toEqual({
        revision,
        membership: { organizationId: ACME, roleSlugs: ["admin", "member"] },
      });
      expect((yield* contexts.membership(GLOBEX)).membership?.roleSlugs).toEqual([
        "Admin",
        "org-admin",
      ]);
      expect(
        (yield* contexts.membership(SignalboxContextId.make("org_plain"))).membership?.roleSlugs,
      ).toEqual([]);
      expect(yield* contexts.membership(PERSONAL_CONTEXT_ID)).toEqual({
        revision,
        membership: null,
      });
      for (const context of yield* contexts.contexts) {
        expect(Object.keys(context).toSorted()).toEqual(["id", "kind", "name", "projectIds"]);
      }
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("moves the revision on role changes and demotion, not on a repeat", () =>
    Effect.gen(function* () {
      const { contexts } = yield* services;
      yield* contexts.syncOrganizations([
        { id: ACME, name: "Acme", roleSlugs: ["admin", "billing"] },
      ]);
      const promoted = yield* contexts.membership(ACME);
      const contextsRevision = yield* contexts.revision;

      // The same roles, reordered and repeated: nothing to write.
      yield* contexts.syncOrganizations([
        { id: ACME, name: "Acme", roleSlugs: ["billing", "admin", "billing"] },
      ]);
      expect(yield* contexts.membership(ACME)).toEqual(promoted);
      expect(yield* contexts.revision).toBe(contextsRevision);

      yield* contexts.syncOrganizations([{ id: ACME, name: "Acme", roleSlugs: ["member"] }]);
      const demoted = yield* contexts.membership(ACME);
      expect(demoted.membership?.roleSlugs).toEqual(["member"]);
      expect(demoted.revision).toBeGreaterThan(promoted.revision);
      expect(yield* contexts.revision).toBeGreaterThan(contextsRevision);

      // A caller that knows no roles leaves none.
      yield* contexts.syncOrganizations([{ id: ACME, name: "Acme" }]);
      const plain = yield* contexts.membership(ACME);
      expect(plain.membership?.roleSlugs).toEqual([]);
      expect(plain.revision).toBeGreaterThan(demoted.revision);
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("versions a removal and restores only the current roles on rejoin", () =>
    Effect.gen(function* () {
      const { contexts, sql } = yield* services;
      yield* contexts.syncOrganizations([{ id: ACME, name: "Acme", roleSlugs: ["admin"] }]);
      const joined = yield* contexts.membership(ACME);

      yield* contexts.syncOrganizations([]);
      const removed = yield* contexts.membership(ACME);
      expect(removed.membership).toBeNull();
      expect(removed.revision).toBeGreaterThan(joined.revision);
      expect(yield* contexts.contextIds).toEqual([PERSONAL_CONTEXT_ID]);
      // Hidden, not deleted, and holding no roles while hidden.
      expect(yield* sql`SELECT id, name, member, role_slugs FROM organizations`).toEqual([
        { id: ACME, name: "Acme", member: 0, role_slugs: "[]" },
      ]);

      yield* contexts.syncOrganizations([{ id: ACME, name: "Acme", roleSlugs: ["member"] }]);
      const rejoined = yield* contexts.membership(ACME);
      expect(rejoined.membership).toEqual({ organizationId: ACME, roleSlugs: ["member"] });
      expect(rejoined.revision).toBeGreaterThan(removed.revision);
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("migrates organizations from before roles to plain memberships", () =>
    Effect.gen(function* () {
      const { contexts, sql } = yield* services;
      yield* contexts.syncOrganizations([{ id: ACME, name: "Acme" }]);
      const before = yield* contexts.membership(ACME);

      // A user object from before `0025`.
      yield* sql`ALTER TABLE organizations DROP COLUMN role_slugs`;
      yield* sql`DELETE FROM effect_sql_migrations
        WHERE migration_id = 25 AND name = 'organization_roles'`;
      yield* sql`INSERT INTO organizations (id, name, member) VALUES (${GLOBEX}, 'Globex', 0)`;

      yield* UserStore.migrate;
      expect(yield* contexts.membership(ACME)).toEqual({
        revision: before.revision,
        membership: { organizationId: ACME, roleSlugs: [] },
      });
      expect((yield* contexts.membership(GLOBEX)).membership).toBeNull();

      yield* contexts.syncOrganizations([
        { id: ACME, name: "Acme", roleSlugs: ["admin"] },
        { id: GLOBEX, name: "Globex" },
      ]);
      expect((yield* contexts.membership(ACME)).membership?.roleSlugs).toEqual(["admin"]);
      expect((yield* contexts.membership(GLOBEX)).membership?.roleSlugs).toEqual([]);
    }).pipe(Effect.provide(layerMemoryStore)),
  );
});
