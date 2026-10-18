import { defineHome } from "@signalbox/sync/definition";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CatalogSetGrant, setCatalogGrant } from "./adapters/catalogGrant.ts";
import {
  CatalogChildren,
  CatalogCreatedFolder,
  CatalogCreateFolder,
  CatalogFolderLifecycle,
  CatalogListChildren,
  catalogLifecycle,
} from "./adapters/catalogLifecycle.ts";
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
  type CatalogPolicyReadContext,
  type CatalogPolicyWriteContext,
} from "./catalogPolicy.ts";

const topology = catalogTopology<CatalogPolicyWriteContext>(resolveCatalogAccess);
const lifecycle = catalogLifecycle<CatalogPolicyReadContext>(resolveCatalogAccess);
const Changed = Schema.Struct({ changed: Schema.Boolean });

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
      children: view({
        input: CatalogListChildren,
        output: CatalogChildren,
        failure: CatalogPolicyFailure,
        run: lifecycle.listChildren,
      }),
    },
    changes: {
      createFolder: change({
        input: CatalogCreateFolder,
        output: CatalogCreatedFolder,
        failure: CatalogPolicyFailure,
        run: lifecycle.createFolder,
      }),
      retireFolder: change({
        input: CatalogFolderLifecycle,
        output: Changed,
        failure: CatalogPolicyFailure,
        run: lifecycle.retireFolder,
      }),
      reopenFolder: change({
        input: CatalogFolderLifecycle,
        output: Changed,
        failure: CatalogPolicyFailure,
        run: lifecycle.reopenFolder,
      }),
      renameFolder: change({
        input: CatalogRenameFolder,
        output: Changed,
        failure: CatalogPolicyFailure,
        run: topology.renameFolder,
      }),
      moveFolder: change({
        input: CatalogMoveFolder,
        output: Changed,
        failure: CatalogPolicyFailure,
        run: topology.moveFolder,
      }),
      setGrant: change({
        input: CatalogSetGrant,
        output: Changed,
        failure: CatalogPolicyFailure,
        run: setCatalogGrant<CatalogPolicyWriteContext>(resolveCatalogAccess),
      }),
    },
    projections: {},
  }),
);
