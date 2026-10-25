import { Folder, FolderId } from "@t3tools/contracts/signalboxFolders";
import type { PageCursor } from "@signalbox/sync/table";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { catalogHomeKey } from "../catalogHome.ts";
import { CatalogLevelRef } from "../catalogHomeSchema.ts";
import type { catalogRootTables } from "../catalogHomeTables.ts";
import {
  CatalogPolicyFailure,
  CatalogPolicyTarget,
  type CatalogRootReadContext,
  type CatalogRootWriteContext,
} from "../catalogPolicy.ts";
import type { CatalogAccess, CatalogAccessResolver } from "./catalogRootPolicy.ts";

const FolderTarget = Schema.Struct({
  folderId: Schema.toType(FolderId).check(Schema.isTrimmed()),
  incarnation: CatalogPolicyTarget.fields.incarnation,
});
const FolderName = Schema.toType(Folder.fields.name).check(Schema.isTrimmed());

export const CatalogCreateFolder = Schema.Struct({
  parent: CatalogPolicyTarget,
  // Chosen by the caller and never reused, so the physical home can be provisioned by id.
  folderId: FolderTarget.fields.folderId,
  name: FolderName,
});
export const CatalogCreatedFolder = Schema.Struct({ level: CatalogLevelRef });
export const CatalogFolderLifecycle = Schema.Struct({ target: FolderTarget });

/** `after` is the last child of the previous page; storage cursors never leave the root. */
export const CatalogListChildren = Schema.Struct({
  parent: CatalogPolicyTarget,
  after: Schema.NullOr(FolderTarget),
});
export const CatalogChildren = Schema.Struct({
  children: Schema.Array(Schema.Struct({ level: CatalogLevelRef, name: FolderName })),
  next: Schema.NullOr(FolderTarget),
});

const PAGE_SIZE = 100;
type Cursor = PageCursor<typeof catalogRootTables.folders, "byParent">;

const canManage = (access: CatalogAccess) => access.role === "Owner" || access.role === "Admin";
const denied = () => Effect.fail(new CatalogPolicyFailure({ reason: "denied" }));
const invalidState = () => Effect.fail(new CatalogPolicyFailure({ reason: "invalid_state" }));

const requireCapacity = (access: CatalogAccess, changesAccess: boolean) =>
  access.state.revision === Number.MAX_SAFE_INTEGER ||
  access.root.topologyRevision === Number.MAX_SAFE_INTEGER ||
  (changesAccess && access.root.authEpoch === Number.MAX_SAFE_INTEGER)
    ? invalidState()
    : Effect.void;

const advanceTopology = (
  ctx: CatalogRootWriteContext,
  access: CatalogAccess,
  changesAccess: boolean,
) =>
  Effect.gen(function* () {
    const epoch = access.root.authEpoch + (changesAccess ? 1 : 0);
    yield* ctx.tables.root.patch("root", {
      topologyRevision: access.root.topologyRevision + 1,
      authEpoch: epoch,
    });
    yield* ctx.tables.state.patch("state", { revision: access.state.revision + 1 });
    if (changesAccess) {
      yield* ctx.requireAuthorizationFence({ scope: catalogHomeKey(ctx.home), epoch });
    }
  });

// Bound roots are never legacy copies, so the child's canonical home carries no legacy source.
const childLevel = (ctx: CatalogRootReadContext, id: FolderId, incarnation: number) => ({
  home: { owner: ctx.home.owner, level: { _tag: "folder" as const, id } },
  incarnation,
});

/** Logical folder lifecycle on whichever root authority resolves access. */
export const catalogLifecycle = <Ctx extends CatalogRootReadContext>(
  resolveAccess: CatalogAccessResolver<Ctx>,
) => {
  const listChildren = (ctx: Ctx, input: typeof CatalogListChildren.Type) =>
    Effect.gen(function* () {
      yield* resolveAccess(ctx, input.parent);
      const prefix = [input.parent.folderId, input.parent.incarnation] as const;
      let resume: { readonly id: FolderId; readonly position: number } | undefined;
      if (input.after !== null) {
        const found = yield* ctx.tables.folders.get(input.after.folderId);
        if (
          Option.isNone(found) ||
          found.value.incarnation !== input.after.incarnation ||
          found.value.parentId !== input.parent.folderId ||
          found.value.parentIncarnation !== input.parent.incarnation
        ) {
          return yield* denied();
        }
        // A retired `after` keeps its position, so paging survives it being retired meanwhile.
        resume = found.value;
      }

      const children: Array<(typeof CatalogChildren.Type)["children"][number]> = [];
      let last: typeof FolderTarget.Type | undefined;
      let skipping = resume !== undefined;
      let after: Cursor | undefined;
      let more = false;
      do {
        const page = yield* ctx.tables.folders.page("byParent", {
          prefix,
          ...(resume === undefined ? {} : { range: { from: resume.position } }),
          ...(after === undefined ? {} : { after }),
          limit: PAGE_SIZE,
        });
        let at = 0;
        for (; at < page.rows.length && children.length < PAGE_SIZE; at++) {
          const row = page.rows[at]!;
          // Matching by id instead of comparing ids keeps the store's own collation authoritative.
          if (skipping) {
            skipping = row.id !== resume?.id;
            continue;
          }
          if (row.state !== "active") continue;
          children.push({ level: childLevel(ctx, row.id, row.incarnation), name: row.name });
          last = { folderId: row.id, incarnation: row.incarnation };
        }
        after = page.after;
        more = at < page.rows.length || after !== undefined;
      } while (after !== undefined && children.length < PAGE_SIZE);

      return { children, next: children.length === PAGE_SIZE && more ? (last ?? null) : null };
    });

  const createFolder = (
    ctx: Ctx & CatalogRootWriteContext,
    input: typeof CatalogCreateFolder.Type,
  ) =>
    Effect.gen(function* () {
      const access = yield* resolveAccess(ctx, input.parent);
      if (!canManage(access)) return yield* denied();
      // Tombstones keep their id: reusing one would revive its grants and history.
      if (Option.isSome(yield* ctx.tables.folders.get(input.folderId))) return yield* denied();
      const orphans = yield* ctx.tables.folders.page("byParent", {
        prefix: [input.folderId, 1],
        limit: 1,
      });
      if (orphans.rows.length > 0) return yield* invalidState();

      const last = yield* ctx.tables.folders.page("byParent", {
        prefix: [input.parent.folderId, input.parent.incarnation],
        order: "desc",
        limit: 1,
      });
      const position = (last.rows[0]?.position ?? -1) + 1;
      if (position > Number.MAX_SAFE_INTEGER) return yield* invalidState();
      yield* requireCapacity(access, false);

      yield* ctx.tables.folders.insert({
        id: input.folderId,
        parentId: input.parent.folderId,
        parentIncarnation: input.parent.incarnation,
        incarnation: 1,
        name: input.name,
        position,
        state: "active",
      });
      // Nobody's existing access changes; the new level only inherits from its parent.
      yield* advanceTopology(ctx, access, false);
      return { level: childLevel(ctx, input.folderId, 1) };
    });

  const setState =
    (next: "active" | "deleted") =>
    (ctx: Ctx & CatalogRootWriteContext, input: typeof CatalogFolderLifecycle.Type) =>
      Effect.gen(function* () {
        const found = yield* ctx.tables.folders.get(input.target.folderId);
        if (Option.isNone(found) || found.value.incarnation !== input.target.incarnation) {
          return yield* denied();
        }
        const folder = found.value;
        // A retired level fails the normal resolver, so authority comes from its current parent.
        const access = yield* resolveAccess(ctx, {
          folderId: folder.parentId,
          incarnation: folder.parentIncarnation,
        });
        if (!canManage(access)) return yield* denied();
        if (folder.state === next) return { changed: false };
        yield* requireCapacity(access, true);
        // The row, its position, grants and children stay; only visibility of the subtree flips.
        yield* ctx.tables.folders.patch(folder.id, { state: next });
        yield* advanceTopology(ctx, access, true);
        return { changed: true };
      });

  return {
    listChildren,
    createFolder,
    retireFolder: setState("deleted"),
    reopenFolder: setState("active"),
  };
};
