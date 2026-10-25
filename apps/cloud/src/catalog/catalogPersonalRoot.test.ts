import { describe, expect, it } from "@effect/vitest";
import { FolderId } from "@t3tools/contracts/signalboxFolders";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { catalogHomeKey } from "./catalogHome.ts";
import { catalogRootTables } from "./catalogHomeTables.ts";
import { catalogPersonalRoot } from "./catalogPersonalRoot.ts";
import {
  CatalogPersonalRoot,
  CatalogPolicyFailure,
  type CatalogPolicyTarget,
} from "./catalogPolicy.ts";
import { policyContext } from "./tests/policyContext.ts";

const decodeFolder = Schema.decodeUnknownSync(catalogRootTables.folders.row);
const decodeHome = Schema.decodeUnknownSync(CatalogPersonalRoot);
const decodeGrantInput = Schema.decodeUnknownSync(catalogPersonalRoot.changes.setGrant.input);

const root = { folderId: null, incarnation: 1 };
const child = { folderId: FolderId.make("child"), incarnation: 2 };
const sibling = { folderId: FolderId.make("sibling"), incarnation: 1 };
const folder = (id: string, extra = {}) =>
  decodeFolder({
    id,
    parentId: null,
    parentIncarnation: 1,
    incarnation: 1,
    name: id,
    position: 0,
    state: "active",
    ...extra,
  });
const grant = (
  target: CatalogPolicyTarget,
  role: "Admin" | "Member" | "Viewer",
  personId = "guest",
) => ({ ...target, personId, role });
const access = catalogPersonalRoot.views.access;
const setGrant = catalogPersonalRoot.changes.setGrant;
const denied = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => expect(error).toEqual(new CatalogPolicyFailure({ reason: "denied" }))),
  );

describe("personal root policy", () => {
  it.effect("keeps ownership implicit and inherited roles additive", () =>
    Effect.gen(function* () {
      const seeds = {
        folders: [folder("child", { incarnation: 2 })],
        grants: [grant(root, "Admin"), grant(child, "Viewer")],
      };
      expect(yield* access.run(policyContext("owner", seeds).ctx, child)).toEqual({
        role: "Owner",
      });
      expect(yield* access.run(policyContext("guest", seeds).ctx, child)).toEqual({
        role: "Admin",
      });
    }),
  );

  it.effect("a child grant reveals neither its parent nor its sibling", () =>
    Effect.gen(function* () {
      const { ctx } = policyContext("guest", {
        folders: [folder("child", { incarnation: 2 }), folder("sibling")],
        grants: [grant(child, "Viewer")],
      });
      expect(yield* access.run(ctx, child)).toEqual({ role: "Viewer" });
      yield* denied(access.run(ctx, root));
      yield* denied(access.run(ctx, sibling));
    }),
  );

  it.effect("rejects stale targets, missing or deleted ancestors, cycles and retired storage", () =>
    Effect.gen(function* () {
      for (const folders of [
        [],
        [folder("child", { incarnation: 2, state: "deleted" })],
        [folder("child", { incarnation: 3 })],
        [folder("child", { incarnation: 2, parentIncarnation: 2 })],
        [folder("child", { incarnation: 2, parentId: "missing" })],
        [
          folder("child", { incarnation: 2, parentId: "parent" }),
          folder("parent", { state: "deleted" }),
        ],
        [
          folder("child", { incarnation: 2, parentId: "parent", parentIncarnation: 2 }),
          folder("parent"),
        ],
        [
          folder("child", { incarnation: 2, parentId: "parent" }),
          folder("parent", { parentId: "child", parentIncarnation: 2 }),
        ],
      ])
        yield* denied(access.run(policyContext("owner", { folders }).ctx, child));
      yield* denied(access.run(policyContext("owner").ctx, { ...root, incarnation: 2 }));
      yield* denied(
        access.run(policyContext("owner", { state: { storageState: "retired" } }).ctx, root),
      );
    }),
  );

  it.effect("does not apply old grants to recreated levels", () =>
    Effect.gen(function* () {
      const { ctx } = policyContext("guest", {
        folders: [folder("child", { incarnation: 2 })],
        grants: [grant({ ...child, incarnation: 1 }, "Admin")],
      });
      yield* denied(access.run(ctx, child));
    }),
  );

  it.effect("rejects a storage identity that differs from its bound home", () =>
    Effect.gen(function* () {
      const wrong = decodeHome({
        owner: { _tag: "person", id: "other" },
        level: { _tag: "top" },
      });
      const { ctx } = policyContext("owner", { state: { level: { home: wrong, incarnation: 1 } } });
      expect(yield* access.run(ctx, root).pipe(Effect.flip)).toEqual(
        new CatalogPolicyFailure({ reason: "invalid_state" }),
      );
    }),
  );

  it.effect("lets an Admin manage only the levels they can administer", () =>
    Effect.gen(function* () {
      const context = policyContext("guest", {
        folders: [folder("child", { incarnation: 2 }), folder("sibling")],
        grants: [grant(child, "Admin")],
      });
      expect(
        yield* setGrant.run(context.ctx, { target: child, personId: "reader", role: "Viewer" }),
      ).toEqual({ changed: true });
      expect(context.grants.rows()).toContainEqual(grant(child, "Viewer", "reader"));
      expect(context.state.rows()[0]?.revision).toBe(1);
      expect(context.root.rows()[0]?.authEpoch).toBe(1);
      expect(context.fences).toEqual([{ scope: catalogHomeKey(context.ctx.home), epoch: 1 }]);
      yield* denied(setGrant.run(context.ctx, { target: root, personId: "reader", role: "Admin" }));
      yield* denied(
        setGrant.run(context.ctx, { target: sibling, personId: "reader", role: "Admin" }),
      );
    }),
  );

  it.effect("removal falls back to the inherited role; removing every grant denies access", () =>
    Effect.gen(function* () {
      const context = policyContext("owner", {
        folders: [folder("child", { incarnation: 2 })],
        grants: [grant(root, "Viewer"), grant(child, "Admin")],
      });
      const guest = { ...context.ctx, actor: { userId: "guest" } };
      yield* setGrant.run(context.ctx, { target: child, personId: "guest", role: null });
      expect(yield* access.run(guest, child)).toEqual({ role: "Viewer" });
      yield* setGrant.run(context.ctx, { target: root, personId: "guest", role: null });
      yield* denied(access.run(guest, child));
      expect(context.fences.map((fence) => fence.epoch)).toEqual([1, 2]);
    }),
  );

  it.effect("Members and Viewers cannot change grants", () =>
    Effect.gen(function* () {
      for (const role of ["Member", "Viewer"] as const) {
        const context = policyContext("guest", { grants: [grant(root, role)] });
        yield* denied(
          setGrant.run(context.ctx, { target: root, personId: "guest", role: "Admin" }),
        );
        expect(context.fences).toEqual([]);
        expect(context.grants.rows()).toEqual([grant(root, role)]);
      }
    }),
  );

  it.effect("no-op writes keep revisions and authorization epochs unchanged", () =>
    Effect.gen(function* () {
      const context = policyContext("owner", { grants: [grant(root, "Viewer")] });
      for (const input of [
        { target: root, personId: "guest", role: "Viewer" },
        { target: root, personId: "absent", role: null },
      ] as const) {
        expect(yield* setGrant.run(context.ctx, input)).toEqual({ changed: false });
      }
      expect(context.state.rows()[0]?.revision).toBe(0);
      expect(context.root.rows()[0]?.authEpoch).toBe(0);
      expect(context.fences).toEqual([]);
    }),
  );

  it.effect("counter exhaustion fails before changing any grant", () =>
    Effect.gen(function* () {
      for (const seeds of [
        { state: { revision: Number.MAX_SAFE_INTEGER } },
        { root: { authEpoch: Number.MAX_SAFE_INTEGER } },
      ]) {
        const context = policyContext("owner", seeds);
        expect(
          yield* setGrant
            .run(context.ctx, { target: root, personId: "guest", role: "Viewer" })
            .pipe(Effect.flip),
        ).toEqual(new CatalogPolicyFailure({ reason: "invalid_state" }));
        expect(context.grants.rows()).toEqual([]);
        expect(context.fences).toEqual([]);
      }
    }),
  );

  it("rejects unsupported root authorities and caller-supplied ownership", () => {
    for (const home of [
      { owner: { _tag: "organization", id: "org_one" }, level: { _tag: "top" } },
      { owner: { _tag: "person", id: "owner" }, level: { _tag: "top" }, legacySource: "owner" },
    ])
      expect(() => decodeHome(home)).toThrow();
    expect(() => decodeGrantInput({ target: root, personId: "guest", role: "Owner" })).toThrow();
    expect(() =>
      decodeGrantInput({
        target: root,
        personId: " padded",
        role: "Viewer",
      }),
    ).toThrow();
  });
});
