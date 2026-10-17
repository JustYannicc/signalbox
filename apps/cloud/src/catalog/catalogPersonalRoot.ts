import { defineHome } from "@signalbox/sync/definition";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { resolveCatalogAccess } from "./adapters/catalogRootPolicy.ts";
import {
  CatalogRenameFolder,
  CatalogMoveFolder,
  renameCatalogFolder,
  moveCatalogFolder,
} from "./adapters/catalogTopology.ts";
import { CatalogPersonId, catalogHomeKey } from "./catalogHome.ts";
import { catalogRootTables } from "./catalogHomeTables.ts";
import {
  CatalogGrantRole,
  CatalogPersonalRoot,
  CatalogPolicyActor,
  CatalogPolicyFailure,
  CatalogPolicyTarget,
  CatalogRole,
} from "./catalogPolicy.ts";

export const catalogPersonalRoot = defineHome(
  { actor: CatalogPolicyActor, home: CatalogPersonalRoot, tables: catalogRootTables },
  ({ view, change }) => ({
    views: {
      access: view({
        input: CatalogPolicyTarget,
        output: Schema.Struct({ role: CatalogRole }),
        failure: CatalogPolicyFailure,
        run: (ctx, target) =>
          resolveCatalogAccess(ctx, target).pipe(Effect.map(({ role }) => ({ role }))),
      }),
    },
    changes: {
      renameFolder: change({
        input: CatalogRenameFolder,
        output: Schema.Struct({ changed: Schema.Boolean }),
        failure: CatalogPolicyFailure,
        run: renameCatalogFolder,
      }),
      moveFolder: change({
        input: CatalogMoveFolder,
        output: Schema.Struct({ changed: Schema.Boolean }),
        failure: CatalogPolicyFailure,
        run: moveCatalogFolder,
      }),
      setGrant: change({
        input: Schema.Struct({
          target: CatalogPolicyTarget,
          personId: CatalogPersonId,
          role: Schema.NullOr(CatalogGrantRole),
        }),
        output: Schema.Struct({ changed: Schema.Boolean }),
        failure: CatalogPolicyFailure,
        run: (ctx, input) =>
          Effect.gen(function* () {
            const access = yield* resolveCatalogAccess(ctx, input.target);
            if (access.role !== "Owner" && access.role !== "Admin") {
              return yield* Effect.fail(new CatalogPolicyFailure({ reason: "denied" }));
            }
            const key = {
              folderId: input.target.folderId,
              incarnation: input.target.incarnation,
              personId: input.personId,
            };
            const existing = yield* ctx.tables.grants.get(key);
            if (
              (input.role === null && Option.isNone(existing)) ||
              (Option.isSome(existing) && existing.value.role === input.role)
            ) {
              return { changed: false };
            }
            if (
              access.root.authEpoch === Number.MAX_SAFE_INTEGER ||
              access.state.revision === Number.MAX_SAFE_INTEGER
            ) {
              return yield* Effect.fail(new CatalogPolicyFailure({ reason: "invalid_state" }));
            }

            if (input.role === null) {
              yield* ctx.tables.grants.delete(key);
            } else {
              const row = { ...key, role: input.role };
              yield* Option.isSome(existing)
                ? ctx.tables.grants.replace(key, row)
                : ctx.tables.grants.insert(row);
            }
            const epoch = access.root.authEpoch + 1;
            yield* ctx.tables.root.patch("root", { authEpoch: epoch });
            yield* ctx.tables.state.patch("state", { revision: access.state.revision + 1 });
            yield* ctx.requireAuthorizationFence({ scope: catalogHomeKey(ctx.home), epoch });
            return { changed: true };
          }),
      }),
    },
    projections: {},
  }),
);
