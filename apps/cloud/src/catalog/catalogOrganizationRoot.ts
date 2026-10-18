import { defineHome } from "@signalbox/sync/definition";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CatalogSetGrant, setCatalogGrant } from "./adapters/catalogGrant.ts";
import {
  CatalogMoveFolder,
  CatalogRenameFolder,
  catalogTopology,
} from "./adapters/catalogTopology.ts";
import {
  bootstrapOrganizationRoot,
  CatalogMembershipDelivery,
  CatalogOrganizationBootstrap,
  CatalogOrganizationRoot,
  type CatalogOrganizationWriteContext,
  resolveOrganizationAccess,
  syncOrganizationMembership,
} from "./catalogOrganizationPolicy.ts";
import { catalogOrganizationTables } from "./catalogOrganizationTables.ts";
import {
  CatalogPolicyActor,
  CatalogPolicyFailure,
  CatalogPolicyTarget,
  CatalogRole,
} from "./catalogPolicy.ts";

const topology = catalogTopology<CatalogOrganizationWriteContext>(resolveOrganizationAccess);
const Changed = Schema.Struct({ changed: Schema.Boolean });

/**
 * Metadata only: binding it to a Durable Object, its ingress guard and WorkOS delivery
 * is the catalog runtime's job. Projections are trusted ingress, never public changes.
 */
export const catalogOrganizationRoot = defineHome(
  { actor: CatalogPolicyActor, home: CatalogOrganizationRoot, tables: catalogOrganizationTables },
  ({ view, change, projection }) => ({
    views: {
      access: view({
        input: CatalogPolicyTarget,
        output: Schema.Struct({ role: CatalogRole }),
        failure: CatalogPolicyFailure,
        run: (ctx, target) =>
          resolveOrganizationAccess(ctx, target).pipe(Effect.map(({ role }) => ({ role }))),
      }),
    },
    changes: {
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
        run: setCatalogGrant<CatalogOrganizationWriteContext>(resolveOrganizationAccess),
      }),
    },
    projections: {
      bootstrap: projection({
        input: CatalogOrganizationBootstrap,
        output: Changed,
        failure: CatalogPolicyFailure,
        run: bootstrapOrganizationRoot,
      }),
      syncMembership: projection({
        input: CatalogMembershipDelivery,
        output: Changed,
        failure: CatalogPolicyFailure,
        run: syncOrganizationMembership,
      }),
    },
  }),
);
