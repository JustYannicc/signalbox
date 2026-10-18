import { describe, expect, it } from "@effect/vitest";
import { FolderId } from "@t3tools/contracts/signalboxFolders";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { catalogPersonalRoot as personal } from "./catalogPersonalRoot.ts";
import { catalogPersonalTables } from "./catalogPersonalTables.ts";
import { denied, invalidState } from "./tests/organizationFixtures.ts";
import {
  personalHome,
  personalRoot,
  personalState,
  referenceContext,
} from "./tests/referenceContext.ts";

const ensureOp = personal.projections.ensureOrganizationReference;
const moveOp = personal.changes.moveOrganizationReference;
const listOp = personal.views.referencePlacements;
const decodeEnsure = Schema.decodeUnknownSync(ensureOp.input);
const decodeMove = Schema.decodeUnknownSync(moveOp.input);
const decodeList = Schema.decodeUnknownSync(listOp.input);
const decodeReference = Schema.decodeUnknownSync(catalogPersonalTables.organizationReferences.row);

const orgTop = (id = "org_one", incarnation = 1) => ({
  home: { owner: { _tag: "organization", id }, level: { _tag: "top" } },
  incarnation,
});
const level = (folderId: string | null, incarnation = 1, owner = "owner") => ({
  home: {
    owner: { _tag: "person", id: owner },
    level: folderId === null ? { _tag: "top" } : { _tag: "folder", id: folderId },
  },
  incarnation,
});
const folder = (id: string, extra = {}) => ({
  id,
  parentId: null,
  parentIncarnation: 1,
  incarnation: 1,
  name: id,
  position: 0,
  state: "active",
  ...extra,
});
const placement = (target: object, filedUnder: object) => ({ target, filedUnder });

type Context = ReturnType<typeof referenceContext>;
const ensure = (context: Context, target = orgTop(), incarnation = 1) =>
  ensureOp.run(context.projection, decodeEnsure({ incarnation, target }));
const move = (context: Context, filedUnder: object, target = orgTop(), userId = "owner") =>
  moveOp.run(context.as(userId), decodeMove({ target, filedUnder }));
const list = (context: Context, after: string | null = null, userId = "owner") =>
  listOp.run(context.as(userId), decodeList({ after }));
const revision = (context: Context) => context.state.rows()[0]!.revision;

describe("organization references", () => {
  it.effect("a new reference files at the personal top and repeats preserve its filing", () =>
    Effect.gen(function* () {
      const context = referenceContext({ folders: [folder("work")] });
      expect(yield* ensure(context)).toEqual({ changed: true });
      expect(yield* list(context)).toEqual({
        placements: [placement(orgTop(), level(null))],
        next: null,
      });
      expect(yield* move(context, level("work"))).toEqual({ changed: true });
      expect(yield* move(context, level("work"))).toEqual({ changed: false });
      expect(yield* ensure(context)).toEqual({ changed: false });
      expect((yield* list(context)).placements).toEqual([placement(orgTop(), level("work"))]);
      expect(revision(context)).toBe(2);
    }),
  );

  it.effect("filing never touches topology, auth epoch, grants or fences", () =>
    Effect.gen(function* () {
      const context = referenceContext({ folders: [folder("work")] });
      yield* ensure(context);
      yield* move(context, level("work"));
      expect(context.root.rows()).toEqual([personalRoot()]);
      expect(context.grants.rows()).toEqual([]);
      expect(context.folders.rows()).toEqual([folder("work")]);
      expect(context.fences).toEqual([]);
    }),
  );

  it.effect("moves only into a live level of the bound owner's own tree", () =>
    Effect.gen(function* () {
      const context = referenceContext({
        folders: [
          folder("retired", { state: "deleted" }),
          folder("nested", { parentId: "retired" }),
          folder("recreated", { incarnation: 2 }),
        ],
      });
      yield* ensure(context);
      yield* denied(move(context, level("nested")));
      yield* denied(move(context, level("recreated", 1)));
      yield* denied(move(context, level("missing")));
      yield* denied(move(context, level(null, 2)));
      yield* denied(move(context, level(null, 1, "someone")));
      expect(() => decodeMove({ target: orgTop(), filedUnder: orgTop("org_two") })).toThrow();
      expect(() =>
        decodeMove({
          target: orgTop(),
          filedUnder: { ...level(null), home: { ...level(null).home, legacySource: "owner" } },
        }),
      ).toThrow();
      expect((yield* list(context)).placements).toEqual([placement(orgTop(), level(null))]);
      expect(revision(context)).toBe(1);
    }),
  );

  it.effect("only the personal root's owner lists or files, whatever their grants", () =>
    Effect.gen(function* () {
      const context = referenceContext({
        folders: [folder("work")],
        grants: [{ folderId: null, incarnation: 1, personId: "guest", role: "Admin" }],
      });
      yield* ensure(context);
      yield* denied(list(context, null, "guest"));
      yield* denied(move(context, level("work"), orgTop(), "guest"));
      expect((yield* list(context)).placements).toEqual([placement(orgTop(), level(null))]);
    }),
  );

  it.effect("a move needs the existing reference at the current target incarnation", () =>
    Effect.gen(function* () {
      const context = referenceContext({ folders: [folder("work")] });
      yield* denied(move(context, level("work")));
      yield* ensure(context, orgTop("org_one", 2));
      yield* denied(move(context, level("work"), orgTop("org_one", 1)));
      yield* denied(move(context, level("work"), orgTop("org_one", 3)));
      expect(yield* move(context, level("work"), orgTop("org_one", 2))).toEqual({ changed: true });
    }),
  );

  it.effect("ignores older target incarnations and keeps filing across a newer one", () =>
    Effect.gen(function* () {
      const context = referenceContext({ folders: [folder("work")] });
      yield* ensure(context, orgTop("org_one", 2));
      yield* move(context, level("work"), orgTop("org_one", 2));
      expect(yield* ensure(context, orgTop("org_one", 1))).toEqual({ changed: false });
      expect(yield* ensure(context, orgTop("org_one", 3))).toEqual({ changed: true });
      expect((yield* list(context)).placements).toEqual([
        placement(orgTop("org_one", 3), level("work")),
      ]);
      expect(revision(context)).toBe(3);
    }),
  );

  it.effect("keeps placements under a retired folder until the owner moves them", () =>
    Effect.gen(function* () {
      const context = referenceContext({ folders: [folder("work")] });
      yield* ensure(context);
      yield* move(context, level("work"));
      // Retiring the folder, or the member leaving, deletes no reference.
      yield* context.folders.table.patch(FolderId.make("work"), { state: "deleted" });
      expect(yield* ensure(context)).toEqual({ changed: false });
      expect((yield* list(context)).placements).toEqual([placement(orgTop(), level("work"))]);
      expect(yield* move(context, level(null))).toEqual({ changed: true });
    }),
  );

  it.effect("trusted ensure rejects retired, wrong, partial or exhausted roots", () =>
    Effect.gen(function* () {
      const cases = [
        { state: [personalState({ storageState: "retired" })] },
        { state: [personalState({}, personalHome("someone"))] },
        { state: [] },
        { root: [] },
        { state: [personalState({ revision: Number.MAX_SAFE_INTEGER })] },
      ];
      for (const seeds of cases) {
        const context = referenceContext(seeds);
        yield* invalidState(ensure(context));
        expect(context.organizationReferences.rows()).toEqual([]);
      }
      yield* invalidState(ensure(referenceContext(), orgTop(), 2));
      expect(() => decodeEnsure({ incarnation: 1, target: level(null) })).toThrow();
      expect(() =>
        decodeEnsure({
          incarnation: 1,
          target: { ...orgTop(), home: { ...orgTop().home, level: { _tag: "folder", id: "f" } } },
        }),
      ).toThrow();
    }),
  );

  it.effect("a retired personal root denies filing and corrupt rows fail closed", () =>
    Effect.gen(function* () {
      const reference = {
        organizationId: "org_one",
        incarnation: 1,
        target: orgTop(),
        filedUnder: level(null),
      };
      const retired = referenceContext({
        state: [personalState({ storageState: "retired" })],
        organizationReferences: [reference],
      });
      yield* denied(list(retired));
      yield* denied(move(retired, level(null)));

      const stale = referenceContext({
        organizationReferences: [{ ...reference, incarnation: 2 }],
      });
      yield* invalidState(ensure(stale));
      const foreign = referenceContext({
        organizationReferences: [{ ...reference, filedUnder: level(null, 1, "someone") }],
      });
      yield* invalidState(ensure(foreign));
      expect(() => decodeReference({ ...reference, organizationId: "org_two" })).toThrow();
    }),
  );

  it.effect("pages placements in organization order", () =>
    Effect.gen(function* () {
      const context = referenceContext();
      const ids = Array.from({ length: 101 }, (_, at) => `org_${String(at).padStart(3, "0")}`);
      for (const id of ids) yield* ensure(context, orgTop(id));
      const first = yield* list(context);
      expect(first.placements.length).toBe(100);
      expect(first.next).toBe("org_099");
      const second = yield* list(context, first.next);
      expect(second).toEqual({
        placements: [placement(orgTop("org_100"), level(null))],
        next: null,
      });
      expect(revision(context)).toBe(101);
    }),
  );
});
