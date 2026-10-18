import { internalAction, internalMutation, internalQuery, v } from "./_generated/server.js";
import { internal } from "./_generated/internal.js";
import { bindRecovery } from "./binding.ts";
import { SyncReceipt } from "@signalbox/sync/definition";
import { toLunoraReadContext, toLunoraWriteContext } from "@signalbox/sync/adapters/lunoraContext";

export const sync_pendingFences = internalQuery
  .input({
    home: v.object({
      owner: v.object({
        _tag: v.literal("person"),
        id: v.string(),
      }),
      level: v.object({
        _tag: v.literal("top"),
      }),
    }),
    after: v.optional(v.union(v.string(), v.null())),
  })
  .output(
    v.object({
      receipts: v.array(
        v.object({
          receipt: v.string(),
          fences: v.array(v.object({ scope: v.string(), epoch: v.number() })),
        }),
      ),
      after: v.union(v.string(), v.null()),
    }),
  )
  .query(async ({ ctx, args }) => {
    const { runtime } = await bindRecovery(ctx, args.home);
    const page = await runtime.pendingFences({
      ctx: toLunoraReadContext(ctx),
      after: args.after ?? null,
    });
    return {
      after: page.after,
      receipts: page.receipts.map(({ receipt, fences }) => ({
        receipt,
        fences: fences.map((fence) => ({ ...fence })),
      })),
    };
  });

export const sync_scheduleFenceRecovery = internalMutation
  .input({
    home: v.object({
      owner: v.object({
        _tag: v.literal("person"),
        id: v.string(),
      }),
      level: v.object({
        _tag: v.literal("top"),
      }),
    }),
    after: v.optional(v.union(v.string(), v.null())),
  })
  .output(v.string())
  .mutation(async ({ ctx, args }) => {
    const { runtime } = await bindRecovery(ctx, args.home);
    return runtime.scheduleFenceRecovery({
      ctx: toLunoraWriteContext(ctx),
      after: args.after ?? null,
    });
  });

export const sync_acknowledgeFence = internalMutation
  .input({
    home: v.object({
      owner: v.object({
        _tag: v.literal("person"),
        id: v.string(),
      }),
      level: v.object({
        _tag: v.literal("top"),
      }),
    }),
    receipt: v.string(),
  })
  .output(v.null())
  .mutation(async ({ ctx, args }) => {
    const { runtime } = await bindRecovery(ctx, args.home);
    await runtime.acknowledgeFence({
      ctx: toLunoraWriteContext(ctx),
      receipt: SyncReceipt.make(args.receipt),
    });
    return null;
  });

export const sync_recoverFences = internalAction
  .input({
    home: v.object({
      owner: v.object({
        _tag: v.literal("person"),
        id: v.string(),
      }),
      level: v.object({
        _tag: v.literal("top"),
      }),
    }),
    after: v.optional(v.union(v.string(), v.null())),
  })
  .output(
    v.union(v.object({ _tag: v.literal("Pending") }), v.object({ _tag: v.literal("Drained") })),
  )
  .action(async ({ ctx, args }) => {
    const { runtime, client } = await bindRecovery(ctx, args.home);
    return runtime.recoverFences(
      {
        pending: async (after) => {
          const page = await client.call(internal["personalRecovery"].sync_pendingFences, {
            home: args.home,
            after,
          });
          return {
            after: page.after,
            receipts: page.receipts.map(({ receipt, fences }) => ({
              receipt: SyncReceipt.make(receipt),
              fences,
            })),
          };
        },
        scheduleNext: (after) =>
          client.call(internal["personalRecovery"].sync_scheduleFenceRecovery, {
            home: args.home,
            after,
          }),
        acknowledge: async (receipt) => {
          await client.call(internal["personalRecovery"].sync_acknowledgeFence, {
            home: args.home,
            receipt,
          });
        },
      },
      args.after ?? null,
    );
  });
