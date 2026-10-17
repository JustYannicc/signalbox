import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { Row, TableReadError } from "@signalbox/sync/table";
import { catalogHomeKey } from "../catalogHome.ts";
import type { CatalogFolderRow } from "../catalogHomeSchema.ts";
import type { catalogRootTables } from "../catalogHomeTables.ts";
import {
  CatalogPolicyFailure,
  type CatalogPolicyReadContext,
  type CatalogPolicyTarget,
  type CatalogRole,
} from "../catalogPolicy.ts";

const roleRank = {
  Viewer: 0,
  Member: 1,
  Admin: 2,
  Owner: 3,
} satisfies Record<CatalogRole, number>;

export const strongestCatalogRole = (a: CatalogRole, b: CatalogRole): CatalogRole =>
  roleRank[a] >= roleRank[b] ? a : b;

const denied = () => Effect.fail(new CatalogPolicyFailure({ reason: "denied" }));
const invalidState = () => Effect.fail(new CatalogPolicyFailure({ reason: "invalid_state" }));

type GrantScope = {
  readonly folderId: typeof CatalogFolderRow.Type.id | null;
  readonly incarnation: number;
};

/** Resolves access only from the bound personal root and its current ancestry. */
export const resolveCatalogAccess = (
  ctx: CatalogPolicyReadContext,
  target: CatalogPolicyTarget,
): Effect.Effect<
  {
    readonly state: Row<typeof catalogRootTables.state>;
    readonly root: Row<typeof catalogRootTables.root>;
    readonly role: CatalogRole;
    readonly ancestry: ReadonlyArray<GrantScope>;
  },
  CatalogPolicyFailure | TableReadError
> =>
  Effect.gen(function* () {
    const boundHome = ctx.home;
    if (boundHome.owner._tag !== "person" || boundHome.legacySource !== undefined) {
      return yield* invalidState();
    }

    const stateResult = yield* ctx.tables.state.get("state");
    const rootResult = yield* ctx.tables.root.get("root");
    if (Option.isNone(stateResult) || Option.isNone(rootResult)) {
      return yield* invalidState();
    }

    const state = stateResult.value;
    const root = rootResult.value;
    if (catalogHomeKey(state.level.home) !== catalogHomeKey(boundHome)) {
      return yield* invalidState();
    }

    if (state.storageState !== "open") return yield* denied();

    const chain: Array<GrantScope> = [];
    if (target.folderId === null) {
      if (target.incarnation !== state.level.incarnation) return yield* denied();
      chain.push({ folderId: null, incarnation: target.incarnation });
    } else {
      const seen = new Set<string>();
      let folderId: typeof CatalogFolderRow.Type.id | null = target.folderId;
      let expectedIncarnation = target.incarnation;

      while (folderId !== null) {
        if (seen.has(folderId)) return yield* denied();
        seen.add(folderId);

        const folderResult: Option.Option<typeof CatalogFolderRow.Type> =
          yield* ctx.tables.folders.get(folderId);
        if (Option.isNone(folderResult)) return yield* denied();
        const folder: typeof CatalogFolderRow.Type = folderResult.value;
        if (folder.state !== "active" || folder.incarnation !== expectedIncarnation) {
          return yield* denied();
        }
        chain.push({ folderId: folder.id, incarnation: folder.incarnation });

        if (folder.parentId === null) {
          if (folder.parentIncarnation !== state.level.incarnation) return yield* denied();
          chain.push({ folderId: null, incarnation: state.level.incarnation });
          folderId = null;
        } else {
          folderId = folder.parentId;
          expectedIncarnation = folder.parentIncarnation;
        }
      }
    }

    if (boundHome.owner.id === ctx.actor.userId) {
      return { state, root, role: "Owner", ancestry: chain };
    }

    let role: CatalogRole | null = null;
    for (const scope of chain.toReversed()) {
      const grantResult = yield* ctx.tables.grants.get({
        folderId: scope.folderId,
        incarnation: scope.incarnation,
        personId: ctx.actor.userId,
      });
      if (Option.isSome(grantResult)) {
        role =
          role === null
            ? grantResult.value.role
            : strongestCatalogRole(role, grantResult.value.role);
      }
    }

    if (role === null) return yield* denied();
    return { state, root, role, ancestry: chain };
  });
