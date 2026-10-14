import { ProjectId } from "@t3tools/contracts";
import type { SectionsSnapshot } from "@t3tools/contracts/sections";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as Environment from "../environment.ts";
import { layerMemoryStore } from "../testing.ts";
import * as UserContexts from "./UserContexts.ts";
import * as UserSections from "./UserSections.ts";

const ACME = { id: "org_acme", name: "Acme" };
const ACME_PROJECT = ProjectId.make("context:org_acme");
const SCRATCH = Environment.SCRATCH_PROJECT_ID;

/** One context's section names, nested under their parent's, in order. */
const outline = (snapshot: SectionsSnapshot, contextId = "personal") => {
  const render = (parentId: string | null): Array<unknown> =>
    snapshot.sections
      .filter((section) => section.contextId === contextId && section.parentId === parentId)
      .map((section) => {
        const children = render(section.id);
        return children.length > 0 ? { [section.name]: children } : section.name;
      });
  return render(null);
};

const services = Effect.all({
  sections: UserSections.UserSections,
  contexts: UserContexts.UserContexts,
});

const idOf = (snapshot: SectionsSnapshot, name: string) => {
  const section = snapshot.sections.find((candidate) => candidate.name === name);
  if (!section) throw new Error(`no section ${name}`);
  return section.id;
};

const codeOf = <A, R>(effect: Effect.Effect<A, { readonly _tag: string }, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => ("code" in error ? error.code : error._tag)),
  );

describe("UserSections", () => {
  it.effect("puts every section in one of the user's contexts, subsections in their parent's", () =>
    Effect.gen(function* () {
      const { sections, contexts } = yield* services;
      yield* contexts.syncOrganizations([ACME]);
      const work = yield* sections.create({ name: "Work", parentId: null, contextId: "org_acme" });
      const nested = yield* sections.create({ name: "Northwind", parentId: idOf(work, "Work") });
      expect(
        nested.sections.map((section) => [section.name, section.contextId]).toSorted(),
      ).toEqual([
        ["Northwind", "org_acme"],
        ["Work", "org_acme"],
      ]);

      // Without a context, a top-level section goes to Personal.
      const loose = yield* sections.create({ name: "Loose", parentId: null });
      expect(loose.sections.find((section) => section.name === "Loose")?.contextId).toBe(
        "personal",
      );
      expect(
        yield* codeOf(sections.create({ name: "X", parentId: null, contextId: "org_gone" })),
      ).toBe("invalid-move");
      expect(
        yield* codeOf(
          sections.create({ name: "X", parentId: idOf(work, "Work"), contextId: "personal" }),
        ),
      ).toBe("invalid-move");
      expect(yield* codeOf(sections.create({ name: "X", parentId: "missing" }))).toBe(
        "section-not-found",
      );
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("orders and nests sections, never below themselves or across contexts", () =>
    Effect.gen(function* () {
      const { sections, contexts } = yield* services;
      yield* contexts.syncOrganizations([ACME]);
      for (const name of ["A", "B", "C"]) {
        yield* sections.create({ name, parentId: null, contextId: "personal" });
      }
      let snapshot = yield* sections.create({ name: "W", parentId: null, contextId: "org_acme" });
      const id = (name: string) => idOf(snapshot, name);

      snapshot = yield* sections.move({ id: id("C"), parentId: null, beforeId: id("A") });
      expect(outline(snapshot)).toEqual(["C", "A", "B"]);
      expect(outline(snapshot, "org_acme")).toEqual(["W"]);
      snapshot = yield* sections.move({ id: id("A"), parentId: id("B") });
      expect(outline(snapshot)).toEqual(["C", { B: ["A"] }]);

      expect(yield* codeOf(sections.move({ id: id("B"), parentId: id("A") }))).toBe("invalid-move");
      expect(yield* codeOf(sections.move({ id: id("C"), parentId: id("W") }))).toBe("invalid-move");
      const before = snapshot.revision;
      // A move that changes nothing isn't a change.
      expect((yield* sections.move({ id: id("A"), parentId: id("B") })).revision).toBe(before);
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("lifts a deleted section's subsections and projects into its place", () =>
    Effect.gen(function* () {
      const { sections } = yield* services;
      let snapshot = yield* sections.create({ name: "A", parentId: null, contextId: "personal" });
      snapshot = yield* sections.create({ name: "B", parentId: null, contextId: "personal" });
      snapshot = yield* sections.create({ name: "B1", parentId: idOf(snapshot, "B") });
      snapshot = yield* sections.moveProject({
        projectId: SCRATCH,
        sectionId: idOf(snapshot, "B"),
      });
      expect(snapshot.projectPlacements).toEqual([
        { projectId: SCRATCH, sectionId: idOf(snapshot, "B"), position: 0 },
      ]);

      snapshot = yield* sections.delete({ id: idOf(snapshot, "B") });
      expect(outline(snapshot)).toEqual(["A", "B1"]);
      // A pool the user doesn't have can't be placed; clearing an empty level changes nothing.
      expect(
        yield* codeOf(sections.update({ id: idOf(snapshot, "A"), defaultPoolId: "pool_1" })),
      ).toBe("invalid-move");
      const unchanged = yield* sections.update({ id: idOf(snapshot, "A"), defaultPoolId: null });
      expect(unchanged.revision).toBe(snapshot.revision);
      expect(snapshot.projectPlacements).toEqual([
        { projectId: SCRATCH, sectionId: null, position: 0 },
      ]);
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("starts every user on Personal, placed at the top level for everything below", () =>
    Effect.gen(function* () {
      const { sections } = yield* services;
      const { pools } = yield* sections.snapshot;
      expect(pools?.top).toEqual({ poolId: "personal", from: { _tag: "top" } });
      expect(pools?.projects).toEqual([
        { projectId: SCRATCH, pool: { poolId: "personal", from: { _tag: "top" } } },
      ]);
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("runs a project on its nearest section's pool, and on the next one when it moves", () =>
    Effect.gen(function* () {
      const { sections } = yield* services;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO pools (id, object_name, name, personal, backing_url, created_at)
        VALUES ('work', 'user_1:work', 'Work', 0, NULL, 0)`;
      let snapshot = yield* sections.create({ name: "Work", parentId: null });
      snapshot = yield* sections.create({ name: "Clients", parentId: idOf(snapshot, "Work") });
      const work = idOf(snapshot, "Work");
      snapshot = yield* sections.update({ id: work, defaultPoolId: "work" });
      expect(snapshot.sections.find((section) => section.id === work)?.defaultPoolId).toBe("work");
      snapshot = yield* sections.moveProject({
        projectId: SCRATCH,
        sectionId: idOf(snapshot, "Clients"),
      });
      const projectPool = (current: SectionsSnapshot) =>
        current.pools?.projects.find((entry) => entry.projectId === SCRATCH)?.pool;
      expect(projectPool(snapshot)).toEqual({
        poolId: "work",
        from: { _tag: "section", sectionId: work },
      });
      expect((yield* sections.pools).projects).toEqual(snapshot.pools?.projects);

      // Out of the section, it's back on the top level's pool.
      snapshot = yield* sections.moveProject({ projectId: SCRATCH, sectionId: null });
      expect(projectPool(snapshot)?.poolId).toBe("personal");

      // Deleting the pool takes it off the section, which inherits again.
      snapshot = yield* sections.moveProject({ projectId: SCRATCH, sectionId: work });
      yield* sql`DELETE FROM pools WHERE id = 'work'`;
      yield* sections.forgetPool("work");
      const after = yield* sections.snapshot;
      expect(after.revision).toBeGreaterThan(snapshot.revision);
      expect(after.sections.find((section) => section.id === work)?.defaultPoolId).toBeUndefined();
      expect(projectPool(after)?.poolId).toBe("personal");
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("keeps projects in sections of their own context", () =>
    Effect.gen(function* () {
      const { sections, contexts } = yield* services;
      yield* contexts.syncOrganizations([ACME]);
      const snapshot = yield* sections.create({ name: "W", parentId: null, contextId: "org_acme" });
      expect(
        yield* codeOf(sections.moveProject({ projectId: SCRATCH, sectionId: idOf(snapshot, "W") })),
      ).toBe("invalid-move");
      expect(
        yield* codeOf(
          sections.moveProject({ projectId: ProjectId.make("context:org_gone"), sectionId: null }),
        ),
      ).toBe("project-not-found");
      const placed = yield* sections.moveProject({
        projectId: ACME_PROJECT,
        sectionId: idOf(snapshot, "W"),
      });
      expect(placed.projectPlacements.map((row) => row.projectId)).toEqual([ACME_PROJECT]);
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("hides a left organization's sections and brings them back on rejoining", () =>
    Effect.gen(function* () {
      const { sections, contexts } = yield* services;
      yield* contexts.syncOrganizations([ACME]);
      let snapshot = yield* sections.create({ name: "W", parentId: null, contextId: "org_acme" });
      snapshot = yield* sections.moveProject({
        projectId: ACME_PROJECT,
        sectionId: idOf(snapshot, "W"),
      });

      yield* contexts.syncOrganizations([]);
      const left = yield* sections.snapshot;
      expect(left.sections).toEqual([]);
      expect(left.projectPlacements).toEqual([]);
      // Leaving is a change, so clients take the new snapshot over the old one.
      expect(left.revision).toBeGreaterThan(snapshot.revision);

      yield* contexts.syncOrganizations([ACME]);
      const back = yield* sections.snapshot;
      expect(outline(back, "org_acme")).toEqual(["W"]);
      expect(back.projectPlacements.map((row) => row.projectId)).toEqual([ACME_PROJECT]);
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("streams every change, sections and contexts alike, to every subscriber", () =>
    Effect.gen(function* () {
      const { sections, contexts } = yield* services;
      const watching = yield* Deferred.make<void>();
      const watcher = yield* sections.changes.pipe(
        Stream.tap(() => Deferred.succeed(watching, undefined)),
        Stream.map((snapshot) => snapshot.sections.map((section) => section.name).toSorted()),
        Stream.takeUntil((names) => names.includes("W")),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(watching);
      yield* sections.create({ name: "Inbox", parentId: null, contextId: "personal" });
      yield* contexts.syncOrganizations([ACME]);
      yield* sections.create({ name: "W", parentId: null, contextId: "org_acme" });
      const seen = yield* Fiber.join(watcher);
      expect(seen[0]).toEqual([]);
      expect(seen.at(-1)).toEqual(["Inbox", "W"]);
    }).pipe(Effect.provide(layerMemoryStore)),
  );
});

describe("UserContexts", () => {
  it.effect("lists Personal first, then each organization, each with its project", () =>
    Effect.gen(function* () {
      const { contexts } = yield* services;
      yield* contexts.syncOrganizations([{ id: "org_beta", name: "beta labs" }, ACME]);
      expect(
        (yield* contexts.contexts).map((context) => [context.name, context.projectIds]),
      ).toEqual([
        ["Personal", [SCRATCH]],
        ["Acme", [ACME_PROJECT]],
        ["beta labs", [ProjectId.make("context:org_beta")]],
      ]);
      // An unchanged membership list writes nothing.
      const revision = yield* contexts.revision;
      yield* contexts.syncOrganizations([ACME, { id: "org_beta", name: "beta labs" }]);
      expect(yield* contexts.revision).toBe(revision);
    }).pipe(Effect.provide(layerMemoryStore)),
  );
});
