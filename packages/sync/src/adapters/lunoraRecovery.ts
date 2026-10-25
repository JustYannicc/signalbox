import type { SyncSchema } from "../definition.ts";
import { emitEncodedValidator } from "./lunoraValidators.ts";

/** Emits server-only recovery functions; bindRecovery resolves the canonical home and native shard client. */
export function emitLunoraRecovery(
  home: SyncSchema,
  options: {
    readonly bindingImport: string;
    readonly moduleName: string;
    readonly serverImport?: string;
    readonly internalImport?: string;
  },
) {
  if (!/^[$A-Z_a-z][$\w]*$/u.test(options.moduleName)) {
    throw new Error(
      "Recovery moduleName must be a JavaScript identifier matching its Lunora file name",
    );
  }
  const homeValidator = emitEncodedValidator(home, "recovery.home");
  const after = "v.optional(v.union(v.string(), v.null()))";
  const functions = {
    pending: "sync_pendingFences",
    schedule: "sync_scheduleFenceRecovery",
    acknowledge: "sync_acknowledgeFence",
    recover: "sync_recoverFences",
  } as const;
  const names = `internal[${JSON.stringify(options.moduleName)}]`;
  const source = `import { internalAction, internalMutation, internalQuery, v } from ${JSON.stringify(options.serverImport ?? "./_generated/server.js")};
import { internal } from ${JSON.stringify(options.internalImport ?? "./_generated/internal.js")};
import { bindRecovery } from ${JSON.stringify(options.bindingImport)};
import { SyncReceipt } from "@signalbox/sync/definition";
import { toLunoraReadContext, toLunoraWriteContext } from "@signalbox/sync/adapters/lunoraContext";

export const ${functions.pending} = internalQuery
  .input({ home: ${homeValidator}, after: ${after} })
  .output(v.object({
    receipts: v.array(v.object({ receipt: v.string(), fences: v.array(v.object({ scope: v.string(), epoch: v.number() })) })),
    after: v.union(v.string(), v.null()),
  }))
  .query(async ({ ctx, args }) => {
    const { runtime } = await bindRecovery(ctx, args.home);
    return runtime.pendingFences({ ctx: toLunoraReadContext(ctx), after: args.after ?? null });
  });

export const ${functions.schedule} = internalMutation
  .input({ home: ${homeValidator}, after: ${after} })
  .output(v.string())
  .mutation(async ({ ctx, args }) => {
    const { runtime } = await bindRecovery(ctx, args.home);
    return runtime.scheduleFenceRecovery({ ctx: toLunoraWriteContext(ctx), after: args.after ?? null });
  });

export const ${functions.acknowledge} = internalMutation
  .input({ home: ${homeValidator}, receipt: v.string() })
  .output(v.null())
  .mutation(async ({ ctx, args }) => {
    const { runtime } = await bindRecovery(ctx, args.home);
    await runtime.acknowledgeFence({ ctx: toLunoraWriteContext(ctx), receipt: SyncReceipt.make(args.receipt) });
    return null;
  });

export const ${functions.recover} = internalAction
  .input({ home: ${homeValidator}, after: ${after} })
  .output(v.union(v.object({ _tag: v.literal("Pending") }), v.object({ _tag: v.literal("Drained") })))
  .action(async ({ ctx, args }) => {
    const { runtime, client } = await bindRecovery(ctx, args.home);
    return runtime.recoverFences({
      pending: (after) => client.call(${names}.${functions.pending}, { home: args.home, after }),
      scheduleNext: (after) => client.call(${names}.${functions.schedule}, { home: args.home, after }),
      acknowledge: async (receipt) => {
        await client.call(${names}.${functions.acknowledge}, { home: args.home, receipt });
      },
    }, args.after ?? null);
  });
`;
  return { source, functions, recoveryTarget: `${options.moduleName}:${functions.recover}` };
}
