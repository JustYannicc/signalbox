import { defineHome } from "@signalbox/sync/definition";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CatalogSetGrant, setCatalogGrant } from "./adapters/catalogGrant.ts";
import { resolveCatalogAccess } from "./adapters/catalogRootPolicy.ts";
import {
  CatalogMoveFolder,
  CatalogRenameFolder,
  catalogTopology,
} from "./adapters/catalogTopology.ts";
import { catalogRootTables } from "./catalogHomeTables.ts";
import {
  CatalogPersonalRoot,
  CatalogPolicyActor,
  CatalogPolicyFailure,
  CatalogPolicyTarget,
  CatalogRole,
  type CatalogPolicyWriteContext,
} from "./catalogPolicy.ts";

const topology = catalogTopology<CatalogPolicyWriteContext>(resolveCatalogAccess);

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
        run: topology.renameFolder,
      }),
      moveFolder: change({
        input: CatalogMoveFolder,
        output: Schema.Struct({ changed: Schema.Boolean }),
        failure: CatalogPolicyFailure,
        run: topology.moveFolder,
      }),
      setGrant: change({
        input: CatalogSetGrant,
        output: Schema.Struct({ changed: Schema.Boolean }),
        failure: CatalogPolicyFailure,
        run: setCatalogGrant<CatalogPolicyWriteContext>(resolveCatalogAccess),
      }),
    },
    projections: {},
  }),
);
