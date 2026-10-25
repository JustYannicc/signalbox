import { Effect, Schema } from "effect";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { mutation, query, v } from "./_generated/server.js";

const keySchema = Schema.String;
const amountSchema = Schema.Number;
const queryArgsSchema = Schema.Struct({ key: keySchema });
const mutationArgsSchema = Schema.Struct({ key: keySchema, amount: amountSchema });
const counterSchema = Schema.Number;

type QueryArgs = Schema.Schema.Type<typeof queryArgsSchema>;
type MutationArgs = Schema.Schema.Type<typeof mutationArgsSchema>;

const runEffect =
  <Ctx, Args>() =>
  <Value, Error = never>(
    handler: (input: { ctx: Ctx; args: Args }) => Effect.Effect<Value, Error>,
  ) =>
  (input: { ctx: Ctx; args: Args }) =>
    Effect.runPromise(handler(input));

const queryHandler = runEffect<QueryCtx, QueryArgs>()(({ ctx, args }) =>
  Effect.gen(function* () {
    const counter = yield* Effect.promise(() =>
      ctx.db
        .query("counters")
        .withIndex("by_key", (q) => q.eq("key", args.key))
        .first(),
    );
    return counter?.value ?? 0;
  }),
);

const mutationHandler = runEffect<MutationCtx, MutationArgs>()(({ ctx, args }) =>
  Effect.gen(function* () {
    const counter = yield* Effect.promise(() =>
      ctx.db
        .query("counters")
        .withIndex("by_key", (q) => q.eq("key", args.key))
        .first(),
    );
    const value = (counter?.value ?? 0) + args.amount;
    if (counter) {
      yield* Effect.promise(() => ctx.db.patch(counter._id, { value }));
    } else {
      yield* Effect.promise(() => ctx.db.insert("counters", { key: args.key, value }));
    }
    return value;
  }),
);

export const value = query
  .input({ key: v.from(Schema.toStandardSchemaV1(keySchema)) })
  // Non-inline handlers erase the inferred return in Lunora codegen, so keep
  // the wire return explicit and let this builder check the Effect result.
  .output(v.from(Schema.toStandardSchemaV1(counterSchema)))
  .query(queryHandler);

export const increment = mutation
  .input({
    key: v.from(Schema.toStandardSchemaV1(keySchema)),
    amount: v.from(Schema.toStandardSchemaV1(amountSchema)),
  })
  .output(v.from(Schema.toStandardSchemaV1(counterSchema)))
  .mutation(mutationHandler);

const invalidHandler = query
  .input({ key: v.from(Schema.toStandardSchemaV1(keySchema)) })
  .output(v.from(Schema.toStandardSchemaV1(counterSchema)))
  // @ts-expect-error A number output validator rejects a wrapped string result.
  .query(runEffect<QueryCtx, QueryArgs>()(({ args }) => Effect.succeed(args.key)));

void invalidHandler;
