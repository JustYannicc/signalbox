import { describe, expect, it } from "@effect/vitest";
import { FolderId } from "@t3tools/contracts/signalboxFolders";
import * as Effect from "effect/Effect";

import { catalogPersonalRoot } from "./catalogPersonalRoot.ts";
import { policyContext } from "./tests/policyContext.ts";
import { before, after, target, nested, folder, folders, denied } from "./tests/topologyContext.ts";

const move = catalogPersonalRoot.changes.moveFolder;

describe("catalog folder ordering", () => {
  it.effect("reorders siblings without changing inherited access", () =>
    Effect.gen(function* () {
      const sibling = folder("sibling", { parentId: "before", position: 8 });
      const context = policyContext("owner", {
        folders: [...folders, sibling],
        root: { authEpoch: Number.MAX_SAFE_INTEGER },
      });
      expect(yield* move.run(context.ctx, { target, parent: before, before: null })).toEqual({
        changed: true,
      });
      expect(context.folders.rows().find((row) => row.id === sibling.id)?.position).toBe(0);
      expect(context.folders.rows().find((row) => row.id === target.folderId)?.position).toBe(1);
      expect(context.root.rows()[0]).toEqual({
        key: "root",
        topologyRevision: 1,
        authEpoch: Number.MAX_SAFE_INTEGER,
      });
      expect(context.state.rows()[0]?.revision).toBe(1);
      expect(context.fences).toEqual([]);
    }),
  );

  it.effect("orders before a current sibling across bounded table pages", () =>
    Effect.gen(function* () {
      const siblings = Array.from({ length: 123 }, (_, position) =>
        folder(`sibling-${position}`, { parentId: "after", parentIncarnation: 2, position }),
      );
      const context = policyContext("owner", { folders: [...folders, ...siblings] });
      const last = siblings[122]!;
      yield* move.run(context.ctx, {
        target,
        parent: after,
        before: { folderId: last.id, incarnation: last.incarnation },
      });
      expect(context.folders.rows().find((row) => row.id === target.folderId)?.position).toBe(122);
      expect(context.folders.rows().find((row) => row.id === last.id)?.position).toBe(123);
      expect(context.folders.rows().find((row) => row.id === siblings[0]?.id)?.position).toBe(0);
    }),
  );

  it.effect("can insert before a sibling when old positions tie", () =>
    Effect.gen(function* () {
      const a = folder("a", { parentId: "before" });
      const b = folder("b", { parentId: "before" });
      const context = policyContext("owner", { folders: [...folders, a, b] });
      yield* move.run(context.ctx, {
        target,
        parent: before,
        before: { folderId: b.id, incarnation: b.incarnation },
      });
      const order = context.folders
        .rows()
        .filter((row) => row.parentId === "before")
        .toSorted((a, b) => a.position - b.position)
        .map((row) => row.id);
      expect(order).toEqual([a.id, target.folderId, b.id]);
      expect(context.fences).toEqual([]);
    }),
  );

  it.effect("refuses missing, stale, deleted or wrong-parent ordering targets", () =>
    Effect.gen(function* () {
      const active = folder("sibling", { parentId: "after", parentIncarnation: 2, incarnation: 2 });
      const deleted = folder("deleted", {
        parentId: "after",
        parentIncarnation: 2,
        state: "deleted",
      });
      for (const sibling of [
        before,
        nested,
        { folderId: FolderId.make("absent"), incarnation: 1 },
        { folderId: active.id, incarnation: 1 },
        { folderId: deleted.id, incarnation: 1 },
      ]) {
        const context = policyContext("owner", { folders: [...folders, active, deleted] });
        yield* denied(move.run(context.ctx, { target, parent: after, before: sibling }));
        expect(context.folders.rows()).toEqual([...folders, active, deleted]);
        expect(context.fences).toEqual([]);
      }
    }),
  );
});
