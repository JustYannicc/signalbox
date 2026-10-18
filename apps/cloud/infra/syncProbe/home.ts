import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { defineHome } from "@signalbox/sync/definition";
import { table } from "@signalbox/sync/table";

const CounterRow = Schema.Struct({ key: Schema.String, value: Schema.Number });
const CounterTable = table({
  row: CounterRow,
  key: ["key"],
  indexes: {},
});

const CounterInput = Schema.Struct({ levelId: Schema.String, key: Schema.String });
const IncrementInput = Schema.Struct({
  levelId: Schema.String,
  key: Schema.String,
  amount: Schema.Number,
});

export const counterDefinition = defineHome(
  {
    actor: Schema.Struct({ userId: Schema.String, levelId: Schema.String }),
    home: Schema.Struct({ owner: Schema.Literal("probe"), levelId: Schema.String }),
    tables: { counters: CounterTable },
  },
  ({ view, change }) => ({
    views: {
      value: view({
        input: CounterInput,
        output: Schema.Number,
        failure: Schema.Never,
        run: (context, input) =>
          Effect.gen(function* () {
            const row = yield* context.tables.counters.get(input.key);
            return Option.isSome(row) ? row.value.value : 0;
          }),
      }),
    },
    changes: {
      increment: change({
        input: IncrementInput,
        output: Schema.Number,
        failure: Schema.Never,
        run: (context, input) =>
          Effect.gen(function* () {
            const previous = yield* context.tables.counters.get(input.key);
            const value = (Option.isSome(previous) ? previous.value.value : 0) + input.amount;
            if (Option.isSome(previous)) {
              yield* context.tables.counters.patch(input.key, { value });
            } else {
              yield* context.tables.counters.insert({ key: input.key, value });
            }
            return value;
          }),
      }),
    },
    projections: {},
  }),
);
