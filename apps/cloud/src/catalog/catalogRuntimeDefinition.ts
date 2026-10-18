import { defineHome } from "@signalbox/sync/definition";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { CatalogPersonId, catalogHomeKey } from "./catalogHome.ts";
import { catalogPersonalRoot } from "./catalogPersonalRoot.ts";
import { CatalogPolicyFailure, CatalogPolicyTarget } from "./catalogPolicy.ts";

const PersonalRuntimeHome = Schema.Struct({
  owner: Schema.TaggedStruct("person", { id: CatalogPersonId }),
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
