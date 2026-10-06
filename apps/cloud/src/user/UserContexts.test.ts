import {
  PERSONAL_CONTEXT_ID,
  SignalboxContextId,
  type SignalboxSectionError,
  SignalboxSectionId,
} from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import type { SqlError } from "effect/sql/SqlError";

import { layerMemoryStore } from "../testing.ts";
import * as UserContexts from "./UserContexts.ts";

const ACME = SignalboxContextId.make("org_acme");
const BETA = SignalboxContextId.make("org_beta");
const id = (value: string) => SignalboxSectionId.make(value);

const contexts = UserContexts.UserContexts;

/** Each section's name, nested under its parent's, in sibling order. */
const tree = Effect.gen(function* () {
  const { sections } = yield* (yield* contexts).snapshot;
  const render = (contextId: string, parentId: string | null): Array<unknown> =>
    sections
      .filter((section) => section.contextId === contextId && section.parentId === parentId)
      .map((section) => {
        const children = render(contextId, section.id);
        return children.length > 0 ? { [section.name]: children } : section.name;
      });
  return (contextId: string) => render(contextId, null);
});

const create = (sectionId: string, name: string, parentId: string | null = null) =>
  Effect.flatMap(contexts, (store) =>
    store.createSection({
      sectionId: id(sectionId),
      contextId: PERSONAL_CONTEXT_ID,
      parentId: parentId === null ? null : id(parentId),
      name,
    }),
  );

describe("UserContexts", () => {
  it.effect("shows Personal first, then every organization the user belongs to", () =>
    Effect.gen(function* () {
      const store = yield* contexts;
      expect((yield* store.snapshot).contexts).toEqual([
        { id: "personal", kind: "personal", name: "Personal" },
      ]);
      yield* store.syncOrganizations([
        { id: BETA, name: "beta labs" },
        { id: ACME, name: "Acme" },
      ]);
      expect((yield* store.snapshot).contexts.map((context) => context.name)).toEqual([
        "Personal",
        "Acme",
        "beta labs",
      ]);
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("hides a left organization's sections and brings them back on rejoining", () =>
    Effect.gen(function* () {
      const store = yield* contexts;
      yield* store.syncOrganizations([{ id: ACME, name: "Acme" }]);
      yield* store.createSection({
        sectionId: id("northwind"),
        contextId: ACME,
        parentId: null,
        name: "Northwind",
      });
      yield* store.syncOrganizations([]);
      const left = yield* store.snapshot;
      expect(left.contexts.map((context) => context.id)).toEqual(["personal"]);
      expect(left.sections).toEqual([]);
      expect(
        (yield* store.renameSection({ sectionId: id("northwind"), name: "x" }).pipe(Effect.flip))
          .reason,
      ).toBe("unknown-section");

      yield* store.syncOrganizations([{ id: ACME, name: "Acme Corp" }]);
      expect((yield* tree)(ACME)).toEqual(["Northwind"]);
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("creates sections once per id, only in the user's contexts", () =>
    Effect.gen(function* () {
      const store = yield* contexts;
      yield* create("a", "Work");
      // A retried create is the same section.
      yield* create("a", "Work");
      yield* create("b", "Northwind", "a");
      expect((yield* tree)(PERSONAL_CONTEXT_ID)).toEqual([{ Work: ["Northwind"] }]);

      const reason = <R>(effect: Effect.Effect<void, SignalboxSectionError | SqlError, R>) =>
        effect.pipe(
          Effect.flip,
          Effect.map((error) =>
            error._tag === "SignalboxSectionError" ? error.reason : error._tag,
          ),
        );
      expect(
        yield* reason(
          store.createSection({ sectionId: id("c"), contextId: ACME, parentId: null, name: "c" }),
        ),
      ).toBe("unknown-context");
      expect(yield* reason(create("c", "Orphan", "missing"))).toBe("invalid-parent");

      yield* store.syncOrganizations([{ id: ACME, name: "Acme" }]);
      expect(
        yield* reason(
          store.createSection({ sectionId: id("a"), contextId: ACME, parentId: null, name: "a" }),
        ),
      ).toBe("id-taken");
      // Parents never cross contexts.
      expect(
        yield* reason(
          store.createSection({
            sectionId: id("d"),
            contextId: ACME,
            parentId: id("a"),
            name: "d",
          }),
        ),
      ).toBe("invalid-parent");
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("reorders and nests sections, never below themselves", () =>
    Effect.gen(function* () {
      const store = yield* contexts;
      yield* create("a", "A");
      yield* create("b", "B");
      yield* create("c", "C");
      yield* store.moveSection({ sectionId: id("c"), parentId: null, index: 0 });
      expect((yield* tree)(PERSONAL_CONTEXT_ID)).toEqual(["C", "A", "B"]);

      yield* store.moveSection({ sectionId: id("a"), parentId: id("b"), index: 5 });
      yield* store.moveSection({ sectionId: id("c"), parentId: id("a"), index: 0 });
      expect((yield* tree)(PERSONAL_CONTEXT_ID)).toEqual([{ B: [{ A: ["C"] }] }]);

      const cycle = yield* store
        .moveSection({ sectionId: id("b"), parentId: id("c"), index: 0 })
        .pipe(Effect.flip);
      expect(cycle.reason).toBe("invalid-parent");
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("puts a deleted section's subsections in its place", () =>
    Effect.gen(function* () {
      const store = yield* contexts;
      yield* create("a", "A");
      yield* create("b", "B");
      yield* create("c", "C");
      yield* create("b1", "B1", "b");
      yield* create("b2", "B2", "b");
      yield* store.deleteSection({ sectionId: id("b") });
      expect((yield* tree)(PERSONAL_CONTEXT_ID)).toEqual(["A", "B1", "B2", "C"]);
      yield* store.renameSection({ sectionId: id("b1"), name: "First" });
      expect((yield* tree)(PERSONAL_CONTEXT_ID)).toEqual(["A", "First", "B2", "C"]);
    }).pipe(Effect.provide(layerMemoryStore)),
  );

  it.effect("streams every change to every subscriber", () =>
    Effect.gen(function* () {
      const store = yield* contexts;
      // Two clients: one watches, the other makes changes once it is watching.
      const watching = yield* Deferred.make<void>();
      const watcher = yield* store.changes.pipe(
        Stream.tap(() => Deferred.succeed(watching, undefined)),
        Stream.map((snapshot) => snapshot.sections.map((section) => section.name)),
        // Back-to-back changes may arrive as one snapshot: only the latest state matters.
        Stream.takeUntil((names) => names.includes("Inbox")),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(watching);
      yield* create("a", "Inbox zero");
      yield* store.renameSection({ sectionId: id("a"), name: "Inbox" });
      const seen = yield* Fiber.join(watcher);
      expect(seen[0]).toEqual([]);
      expect(seen.at(-1)).toEqual(["Inbox"]);
    }).pipe(Effect.provide(layerMemoryStore)),
  );
});
