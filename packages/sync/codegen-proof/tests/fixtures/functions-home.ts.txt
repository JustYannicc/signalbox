import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { defineHome } from "@signalbox/sync/definition";

export const counterDefinition = defineHome(
  {
    actor: Schema.Struct({ userId: Schema.String }),
    home: Schema.Struct({ id: Schema.String }),
    tables: {},
  },
  ({ view, change, projection }) => ({
    views: {
      absent: view({
        input: Schema.Void,
        output: Schema.Void,
        failure: Schema.Never,
        run: () => Effect.void,
      }),
      date: view({
        input: Schema.DateFromString,
        output: Schema.DateFromString,
        failure: Schema.Never,
        run: (_context, value) => Effect.succeed(value),
      }),
      nullable: view({
        input: Schema.Void,
        output: Schema.Null,
        failure: Schema.Literal("missing"),
        run: () => Effect.succeed(null),
      }),
    },
    changes: {
      date: change({
        input: Schema.DateFromString,
        output: Schema.DateFromString,
        failure: Schema.Never,
        run: (_context, value) => Effect.succeed(value),
      }),
      absent: change({
        input: Schema.Void,
        output: Schema.Void,
        failure: Schema.Void,
        run: () => Effect.void,
      }),
    },
    projections: {
      touch: projection({
        input: Schema.Void,
        output: Schema.Null,
        failure: Schema.Never,
        run: () => Effect.succeed(null),
      }),
    },
  }),
);
