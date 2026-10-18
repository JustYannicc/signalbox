import { Folder, FolderId } from "@t3tools/contracts/signalboxFolders";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { catalogHomeKey } from "../catalogHome.ts";
import {
  CatalogPolicyFailure,
  CatalogPolicyTarget,
  type CatalogRootWriteContext,
} from "../catalogPolicy.ts";
import type { CatalogAccess, CatalogAccessResolver } from "./catalogRootPolicy.ts";

const FolderTarget = Schema.Struct({
  folderId: Schema.toType(FolderId).check(Schema.isTrimmed()),
  incarnation: CatalogPolicyTarget.fields.incarnation,
});

export const CatalogRenameFolder = Schema.Struct({
  target: FolderTarget,
  name: Schema.toType(Folder.fields.name).check(Schema.isTrimmed()),
});
export const CatalogMoveFolder = Schema.Struct({
  target: FolderTarget,
  parent: CatalogPolicyTarget,
  before: Schema.NullOr(FolderTarget),
});

const readChildren = (ctx: CatalogRootWriteContext, parent: CatalogPolicyTarget) =>
  Effect.gen(function* () {
    const first = yield* ctx.tables.folders.page("byParent", {
      prefix: [parent.folderId, parent.incarnation],
      limit: 100,
    });
    const rows = [...first.rows];
    let after = first.after;
    while (after !== undefined) {
      const page = yield* ctx.tables.folders.page("byParent", {
        prefix: [parent.folderId, parent.incarnation],
        limit: 100,
        after,
      });
      rows.push(...page.rows);
      after = page.after;
    }
    return rows.filter((folder) => folder.state === "active");
  });

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

/** Topology changes run on whichever root authority resolves access. */
export const catalogTopology = <Ctx extends CatalogRootWriteContext>(
  resolveAccess: CatalogAccessResolver<Ctx>,
) => {
  const rename = (ctx: Ctx, input: typeof CatalogRenameFolder.Type) =>
    Effect.gen(function* () {
      const access = yield* resolveAccess(ctx, input.target);
      if (!canManage(access)) return yield* denied();
      const existing = yield* ctx.tables.folders.get(input.target.folderId);
      if (Option.isNone(existing)) return yield* denied();
      if (existing.value.name === input.name) return { changed: false };
      yield* requireCapacity(access, false);
      yield* ctx.tables.folders.patch(input.target.folderId, { name: input.name });
      yield* advanceTopology(ctx, access, false);
      return { changed: true };
    });

  const move = (ctx: Ctx, input: typeof CatalogMoveFolder.Type) =>
    Effect.gen(function* () {
      const source = yield* resolveAccess(ctx, input.target);
      if (!canManage(source)) return yield* denied();
      const destination = yield* resolveAccess(ctx, input.parent);
      if (!canManage(destination)) return yield* denied();
      if (destination.ancestry.some((level) => level.folderId === input.target.folderId)) {
        return yield* denied();
      }

      const existing = yield* ctx.tables.folders.get(input.target.folderId);
      if (Option.isNone(existing)) return yield* denied();
      const moving = existing.value;
      const changesAccess =
        moving.parentId !== input.parent.folderId ||
        moving.parentIncarnation !== input.parent.incarnation;
      if (changesAccess) {
        // Removing a subtree changes access inherited from its current parent.
        const currentParent = yield* resolveAccess(ctx, {
          folderId: moving.parentId,
          incarnation: moving.parentIncarnation,
        });
        if (!canManage(currentParent)) return yield* denied();
      }
      if (input.before?.folderId === input.target.folderId) {
        if (input.before.incarnation !== input.target.incarnation || changesAccess) {
          return yield* denied();
        }
        return { changed: false };
      }

      const siblings = yield* readChildren(ctx, input.parent);
      const others = siblings.filter((folder) => folder.id !== moving.id);
      const index =
        input.before === null
          ? others.length
          : others.findIndex(
              (folder) =>
                folder.id === input.before?.folderId &&
                folder.incarnation === input.before.incarnation,
            );
      if (index < 0) return yield* denied();
      const ordered = [...others.slice(0, index), moving, ...others.slice(index)];
      if (
        !changesAccess &&
        siblings.length === ordered.length &&
        siblings.every((folder, at) => folder.id === ordered[at]?.id)
      ) {
        return { changed: false };
      }
      yield* requireCapacity(source, changesAccess);

      // Admin on the destination inherits access to every child; rows and page cursors stay internal.
      for (const [position, folder] of ordered.entries()) {
        if (folder.id === moving.id) {
          yield* ctx.tables.folders.patch(moving.id, {
            parentId: input.parent.folderId,
            parentIncarnation: input.parent.incarnation,
            position,
          });
        } else if (folder.position !== position) {
          yield* ctx.tables.folders.patch(folder.id, { position });
        }
      }
      yield* advanceTopology(ctx, source, changesAccess);
      return { changed: true };
    });

  return { renameFolder: rename, moveFolder: move };
};
