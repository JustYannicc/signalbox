import { counterDefinition as syncDefinition } from "../home.js";
import { bind as bindHome } from "./binding.js";
import * as Schema from "effect/Schema";
import {
  decodeWireValue,
  validateWireValue,
  type WireValue,
} from "@signalbox/sync/adapters/lunoraWireValue";
import { asLunoraSyncError } from "@signalbox/sync/adapters/lunoraHomeWire";
import { SyncFailure, SyncCursor, type SyncSchema } from "@signalbox/sync/definition";
import { toLunoraReadContext, toLunoraWriteContext } from "@signalbox/sync/adapters/lunoraContext";
import type { QueryCtx, MutationCtx } from "./_generated/server.js";
import { query, mutation, v } from "./_generated/server.js";

const isSyncFailure = Schema.is(SyncFailure);
const mapSyncFailure = async <A>(run: () => Promise<A>): Promise<A> => {
  try {
    return await run();
  } catch (error) {
    if (isSyncFailure(error)) throw asLunoraSyncError(error);
    throw error;
  }
};
const decodeInput = <S extends SyncSchema>(schema: S, value: unknown): Promise<S["Type"]> =>
  mapSyncFailure(() => decodeWireValue(schema, value, "invalid_input"));
const validateOutput = <S extends SyncSchema>(schema: S, value: unknown): Promise<WireValue<S>> =>
  mapSyncFailure(() => validateWireValue(schema, value));

const readContext = (ctx: QueryCtx) => toLunoraReadContext(ctx);

const writeContext = (ctx: MutationCtx) => toLunoraWriteContext(ctx);

export const view_value = query
  .input({
    input: v.object({
      defined: v.literal(true),
      value: v.object({
        levelId: v.string(),
        key: v.string(),
      }),
    }),
    resume: v.optional(v.string()),
  })
  .output(
    v.object({
      _tag: v.literal("Value"),
      value: v.object({ defined: v.literal(true), value: v.number() }),
      cursor: v.string(),
    }),
  )
  .query(async ({ ctx, args }) => {
    const { runtime, actor } = await bindHome(ctx);
    const input = await decodeInput(syncDefinition.views["value"].input, args.input);
    const result = await runtime.observeWire("value")({
      ctx: readContext(ctx),
      args: {
        actor,
        input,
        ...(args.resume === undefined ? {} : { resume: SyncCursor.make(args.resume) }),
      },
    });
    if (result._tag === "Value")
      return {
        ...result,
        value: await validateOutput(syncDefinition.views["value"].output, result.value),
      };
    throw asLunoraSyncError(new SyncFailure({ reason: "invalid_state" }));
  });

export const change_increment = mutation
  .input({
    input: v.object({
      defined: v.literal(true),
      value: v.object({
        levelId: v.string(),
        key: v.string(),
        amount: v.number(),
      }),
    }),
    operationKey: v.string(),
  })
  .output(
    v.union(
      v.object({
        _tag: v.literal("Committed"),
        value: v.object({ defined: v.literal(true), value: v.number() }),
        receipt: v.string(),
      }),
      v.object({ _tag: v.literal("Pending"), operationKey: v.string() }),
    ),
  )
  .mutation(async ({ ctx, args }) => {
    const { runtime, actor } = await bindHome(ctx);
    const input = await decodeInput(syncDefinition.changes["increment"].input, args.input);
    const result = await runtime.changeWire("increment")({
      ctx: writeContext(ctx),
      args: { actor, input, operationKey: args.operationKey },
    });
    if (result._tag === "Committed") {
      return {
        ...result,
        value: await validateOutput(syncDefinition.changes["increment"].output, result.value),
      };
    }
    return result;
  });
