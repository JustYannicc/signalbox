import { describe, expect, it } from "@effect/vitest";
import { FolderId } from "@t3tools/contracts/signalboxFolders";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { catalogHomeKey } from "./catalogHome.ts";
import { catalogPersonalRoot } from "./catalogPersonalRoot.ts";
import { CatalogPolicyFailure } from "./catalogPolicy.ts";
import { policyContext } from "./tests/policyContext.ts";
import {
  top,
  before,
  after,
  target,
  nested,
  folders,
  grant,
  denied,
} from "./tests/topologyContext.ts";

const rename = catalogPersonalRoot.changes.renameFolder;
const move = catalogPersonalRoot.changes.moveFolder;
const access = catalogPersonalRoot.views.access;
const decodeRename = Schema.decodeUnknownSync(rename.input);
const decodeMove = Schema.decodeUnknownSync(move.input);

describe("catalog folder topology", () => {
  it.effect("reparenting switches inherited access for the whole subtree and can be reversed", () =>
    Effect.gen(function* () {
      const context = policyContext("owner", {
        folders,
        grants: [grant(before, "old-reader", "Viewer"), grant(after, "new-reader", "Member")],
      });
      const oldReader = { ...context.ctx, actor: { userId: "old-reader" } };
      const newReader = { ...context.ctx, actor: { userId: "new-reader" } };
      expect(yield* access.run(oldReader, nested)).toEqual({ role: "Viewer" });
      yield* denied(access.run(newReader, nested));
      expect(yield* move.run(context.ctx, { target, parent: after, before: null })).toEqual({
        changed: true,
      });
      yield* denied(access.run(oldReader, nested));
      expect(yield* access.run(newReader, nested)).toEqual({ role: "Member" });
      expect(context.folders.rows().find((row) => row.id === target.folderId)).toMatchObject({
        parentId: after.folderId,
        parentIncarnation: 2,
        incarnation: 3,
        position: 0,
      });
      expect(context.root.rows()[0]).toEqual({ key: "root", topologyRevision: 1, authEpoch: 1 });
      expect(context.state.rows()[0]?.revision).toBe(1);
      expect(context.fences).toEqual([{ scope: catalogHomeKey(context.ctx.home), epoch: 1 }]);

      yield* move.run(context.ctx, { target, parent: before, before: null });
      expect(yield* access.run(oldReader, nested)).toEqual({ role: "Viewer" });
      yield* denied(access.run(newReader, nested));
      expect(context.fences.map(({ epoch }) => epoch)).toEqual([1, 2]);
    }),
  );

  it.effect("moves back to the top level without inheriting from its old parent", () =>
    Effect.gen(function* () {
      const context = policyContext("owner", {
        folders,
        grants: [grant(before, "reader", "Viewer")],
      });
      yield* move.run(context.ctx, { target, parent: top, before });
      expect(context.folders.rows().find((row) => row.id === target.folderId)).toMatchObject({
        parentId: null,
        parentIncarnation: 1,
        position: 1,
      });
      yield* denied(access.run({ ...context.ctx, actor: { userId: "reader" } }, nested));
      expect(context.fences).toEqual([{ scope: catalogHomeKey(context.ctx.home), epoch: 1 }]);
    }),
  );

  it.effect("a folder before itself is a no-op only in its current parent and incarnation", () =>
    Effect.gen(function* () {
      const context = policyContext("owner", { folders });
      expect(yield* move.run(context.ctx, { target, parent: before, before: target })).toEqual({
        changed: false,
      });
      yield* denied(move.run(context.ctx, { target, parent: after, before: target }));
      yield* denied(
        move.run(context.ctx, { target, parent: before, before: { ...target, incarnation: 2 } }),
      );
      expect(context.folders.rows()).toEqual(folders);
      expect(context.fences).toEqual([]);
    }),
  );

  it.effect("requires management access at both source and destination", () =>
    Effect.gen(function* () {
      for (const grants of [
        [grant(target, "guest", "Admin")],
        [grant(target, "guest", "Viewer"), grant(after, "guest", "Admin")],
        [grant(target, "guest", "Admin"), grant(after, "guest", "Member")],
      ]) {
        const context = policyContext("guest", { folders, grants });
        yield* denied(move.run(context.ctx, { target, parent: after, before: null }));
        expect(context.folders.rows()).toEqual(folders);
        expect(context.fences).toEqual([]);
      }
      const context = policyContext("guest", {
        folders,
        grants: [grant(target, "guest", "Admin"), grant(after, "guest", "Admin")],
      });
      expect(yield* move.run(context.ctx, { target, parent: after, before: null })).toEqual({
        changed: true,
      });
    }),
  );

  it.effect("rejects self and descendant destinations without mutation", () =>
    Effect.gen(function* () {
      for (const parent of [target, nested]) {
        const context = policyContext("owner", { folders });
        yield* denied(move.run(context.ctx, { target, parent, before: null }));
        expect(context.folders.rows()).toEqual(folders);
        expect(context.root.rows()[0]?.topologyRevision).toBe(0);
        expect(context.fences).toEqual([]);
      }
    }),
  );

  it.effect("rejects stale, missing and deleted source or destination identities", () =>
    Effect.gen(function* () {
      for (const input of [
        { target: { ...target, incarnation: 2 }, parent: after },
        { target, parent: { ...after, incarnation: 1 } },
        { target, parent: { folderId: FolderId.make("absent"), incarnation: 1 } },
        { target, parent: { ...top, incarnation: 2 } },
      ]) {
        const context = policyContext("owner", { folders });
        yield* denied(move.run(context.ctx, { ...input, before: null }));
        expect(context.folders.rows()).toEqual(folders);
        expect(context.fences).toEqual([]);
      }
      for (const deleted of [target.folderId, after.folderId]) {
        const seeded = folders.map((row) =>
          row.id === deleted ? { ...row, state: "deleted" as const } : row,
        );
        const context = policyContext("owner", { folders: seeded });
        yield* denied(move.run(context.ctx, { target, parent: after, before: null }));
        expect(context.folders.rows()).toEqual(seeded);
      }
    }),
  );

  it.effect("renames with folder-only Admin access and leaves inherited access intact", () =>
    Effect.gen(function* () {
      const context = policyContext("guest", {
        folders,
        grants: [grant(target, "guest", "Admin")],
      });
      yield* denied(access.run(context.ctx, before));
      expect(yield* rename.run(context.ctx, { target, name: "Renamed" })).toEqual({
        changed: true,
      });
      expect(context.folders.rows().find((row) => row.id === target.folderId)?.name).toBe(
        "Renamed",
      );
      expect(yield* access.run(context.ctx, nested)).toEqual({ role: "Admin" });
      expect(context.root.rows()[0]).toEqual({ key: "root", topologyRevision: 1, authEpoch: 0 });
      expect(context.state.rows()[0]?.revision).toBe(1);
      expect(context.fences).toEqual([]);
    }),
  );

  it.effect("does not let Members or Viewers rename a folder", () =>
    Effect.gen(function* () {
      for (const role of ["Member", "Viewer"] as const) {
        const context = policyContext("guest", { folders, grants: [grant(target, "guest", role)] });
        yield* denied(rename.run(context.ctx, { target, name: "Renamed" }));
        expect(context.folders.rows()).toEqual(folders);
        expect(context.state.rows()[0]?.revision).toBe(0);
      }
    }),
  );

  it.effect("no-op placements and names leave even exhausted counters untouched", () =>
    Effect.gen(function* () {
      const context = policyContext("owner", {
        folders,
        state: { revision: Number.MAX_SAFE_INTEGER },
        root: { topologyRevision: Number.MAX_SAFE_INTEGER, authEpoch: Number.MAX_SAFE_INTEGER },
      });
      expect(yield* move.run(context.ctx, { target, parent: before, before: null })).toEqual({
        changed: false,
      });
      expect(yield* rename.run(context.ctx, { target, name: "moving" })).toEqual({
        changed: false,
      });
      expect(context.folders.rows()).toEqual(folders);
      expect(context.fences).toEqual([]);
    }),
  );

  it.effect("counter exhaustion fails before any topology mutation", () =>
    Effect.gen(function* () {
      for (const seeds of [
        { state: { revision: Number.MAX_SAFE_INTEGER } },
        { root: { topologyRevision: Number.MAX_SAFE_INTEGER } },
      ]) {
        const context = policyContext("owner", { folders, ...seeds });
        for (const mutation of [
          move.run(context.ctx, { target, parent: after, before: null }),
          rename.run(context.ctx, { target, name: "Renamed" }),
        ]) {
          expect(yield* mutation.pipe(Effect.flip)).toEqual(
            new CatalogPolicyFailure({ reason: "invalid_state" }),
          );
          expect(context.folders.rows()).toEqual(folders);
          expect(context.fences).toEqual([]);
        }
      }
      const context = policyContext("owner", {
        folders,
        root: { authEpoch: Number.MAX_SAFE_INTEGER },
      });
      expect(
        yield* move.run(context.ctx, { target, parent: after, before: null }).pipe(Effect.flip),
      ).toEqual(new CatalogPolicyFailure({ reason: "invalid_state" }));
      expect(context.folders.rows()).toEqual(folders);
      expect(context.fences).toEqual([]);
    }),
  );

  it("rejects root moves and identity normalization", () => {
    expect(() => decodeRename({ target: top, name: "Name" })).toThrow();
    expect(() => decodeRename({ target, name: " Padded " })).toThrow();
    expect(() => decodeMove({ target: top, parent: after, before: null })).toThrow();
    expect(() =>
      decodeMove({ target: { ...target, folderId: " moving" }, parent: after, before: null }),
    ).toThrow();
    expect(() =>
      decodeMove({ target, parent: after, before: { ...target, folderId: " moving" } }),
    ).toThrow();
  });
});
