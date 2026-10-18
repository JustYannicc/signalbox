import { defineHome } from "@signalbox/sync/definition";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { PERSONAL_CONTEXT_ID, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";

import { catalogOrganizationRoot } from "./catalogOrganizationRoot.ts";
import { CatalogOrganizationRoot } from "./catalogOrganizationPolicy.ts";
import { catalogPersonalRoot } from "./catalogPersonalRoot.ts";
import { CatalogPersonalRoot } from "./catalogPolicy.ts";
import { CatalogPersonId, catalogHomeKey } from "./catalogHome.ts";
import { CatalogPolicyFailure, CatalogPolicyTarget } from "./catalogPolicy.ts";

export { CatalogOrganizationRoot, CatalogPersonalRoot };

/** The runtime accepts only the reviewed canonical root definitions. */
export const CatalogRuntimeHomeSchema = Schema.Union([
  CatalogPersonalRoot,
  CatalogOrganizationRoot,
]);
export type CatalogRuntimeHome = typeof CatalogRuntimeHomeSchema.Type;

const PersonalRuntimeHome = Schema.Struct({
  owner: Schema.TaggedStruct("person", { id: CatalogPersonId }),
  level: Schema.TaggedStruct("top", {}),
});
const OrganizationRuntimeHome = Schema.Struct({
  owner: Schema.TaggedStruct("organization", {
    id: Schema.toType(SignalboxContextId)
      .check(Schema.isTrimmed())
      .check(Schema.makeFilter((id) => id !== PERSONAL_CONTEXT_ID)),
  }),
  level: Schema.TaggedStruct("top", {}),
});

/** Canonical personal homes are provisioned independently of the held legacy cutover. */
export const catalogPersonalRuntime = defineHome(
  {
    actor: catalogPersonalRoot.actor,
    home: PersonalRuntimeHome,
    tables: catalogPersonalRoot.tables,
  },
  ({ projection }) => ({
    views: catalogPersonalRoot.views,
    changes: catalogPersonalRoot.changes,
    projections: {
      ...catalogPersonalRoot.projections,
      initialize: projection({
        input: Schema.Struct({ incarnation: CatalogPolicyTarget.fields.incarnation }),
        output: Schema.Struct({ changed: Schema.Boolean }),
        failure: CatalogPolicyFailure,
        run: (ctx, input) =>
          Effect.gen(function* () {
            const state = yield* ctx.tables.state.get("state");
            const root = yield* ctx.tables.root.get("root");
            if (Option.isSome(state) || Option.isSome(root)) {
              if (
                Option.isSome(state) &&
                Option.isSome(root) &&
                catalogHomeKey(state.value.level.home) === catalogHomeKey(ctx.home) &&
                state.value.level.incarnation === input.incarnation &&
                state.value.storageState === "open"
              ) {
                return { changed: false };
              }
              return yield* Effect.fail(new CatalogPolicyFailure({ reason: "invalid_state" }));
            }
            yield* ctx.tables.state.insert({
              key: "state",
              level: { home: ctx.home, incarnation: input.incarnation },
              revision: 0,
              storageState: "open",
            });
            yield* ctx.tables.root.insert({ key: "root", topologyRevision: 0, authEpoch: 0 });
            return { changed: true };
          }),
      }),
    },
  }),
);

/** Organization bootstrap and membership updates stay trusted Sync projections. */
export const catalogOrganizationRuntime = defineHome(
  {
    actor: catalogOrganizationRoot.actor,
    home: OrganizationRuntimeHome,
    tables: catalogOrganizationRoot.tables,
  },
  () => ({
    views: catalogOrganizationRoot.views,
    changes: catalogOrganizationRoot.changes,
    projections: catalogOrganizationRoot.projections,
  }),
);
