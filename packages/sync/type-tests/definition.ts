import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { defineHome, type SyncHome } from "../src/definition.ts";
import { table } from "../src/table.ts";

const items = table({
  row: Schema.Struct({ id: Schema.String, amount: Schema.Number }),
  key: ["id"],
  indexes: { byAmount: { fields: ["amount"] } },
});

const home = defineHome(
  {
    actor: Schema.Struct({ personId: Schema.String }),
    home: Schema.Struct({ owner: Schema.String, level: Schema.String }),
    tables: { items },
  },
  ({ view, change, projection }) => ({
    views: {
      item: view({
        input: Schema.String,
        output: Schema.Number,
        failure: Schema.Never,
        run: (ctx, id) => ctx.tables.items.get(id).pipe(Effect.as(1)),
      }),
    },
    changes: {
      increment: change({
        input: Schema.Struct({ id: Schema.String, by: Schema.Number }),
        output: Schema.Number,
        failure: Schema.Never,
        run: (ctx, input) =>
          ctx.tables.items.patch(input.id, { amount: input.by }).pipe(Effect.as(input.by)),
      }),
    },
    projections: {
      apply: projection({
        input: Schema.Struct({ id: Schema.String, amount: Schema.Number }),
        output: Schema.Void,
        failure: Schema.Never,
        run: (ctx, row) => ctx.tables.items.insert(row),
      }),
    },
  }),
);

declare const bound: SyncHome<typeof home.actor.Type, { readonly source: "outbox" }, typeof home>;
void bound.view({ personId: "user" }, "item", "key");
void bound.change({ personId: "user" }, "increment", { id: "key", by: 1 }, "operation");
void bound.project({ source: "outbox" }, "apply", { id: "key", amount: 1 }, "delivery");
// @ts-expect-error Projection ingress is not a public change.
void bound.change({ personId: "user" }, "apply", { id: "key", amount: 1 }, "delivery");
// @ts-expect-error The view input is derived from its Effect Schema.
void bound.view({ personId: "user" }, "item", 1);
// @ts-expect-error Typed domain commands reject wrong arguments.
void bound.change({ personId: "user" }, "increment", { id: "key", by: "one" }, "operation");

// Handler output validation is retained during declaration.
defineHome({ actor: Schema.String, home: Schema.String, tables: { items } }, ({ view }) => ({
  views: {
    bad: view({
      input: Schema.String,
      output: Schema.Number,
      failure: Schema.Never,
      // @ts-expect-error Number output cannot be produced by a string Effect.
      run: (_ctx, input) => Effect.succeed(input),
    }),
  },
  changes: {},
  projections: {},
}));
