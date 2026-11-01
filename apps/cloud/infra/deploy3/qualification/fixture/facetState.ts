// @effect-diagnostics globalDate:off - The injected filesystem clock is synchronous and runs outside Effect.
import { createMemoryFilePersistencePorts } from "../../../../src/kernel/MemoryFilePersistencePorts.ts";
import type { FacetStorage } from "../../../../src/kernel/FacetSqliteStorage.ts";
import type { KernelFileSystem } from "../../../../src/kernel/KernelFileSystem.ts";
import type { QualifierCapabilities } from "./capabilities.ts";
import type { HostFiles } from "./snapshot.ts";
import { observeChunkReads } from "./chunkReadObserver.ts";
import { assert } from "./common.ts";
import { createNativeStdioPrefix, type NativeStdioChannel } from "./nativeOutputPrefix.ts";

type FlushReason = "checkpoint" | "request-settled";

export interface FacetState {
  readonly files: HostFiles;
  readonly reads: ReturnType<typeof observeChunkReads>;
  readonly rawOrdinals: Map<string, number>;
  readonly outputPrefixEnabled: boolean;
  readonly raw: (channel: NativeStdioChannel, bytes: Uint8Array) => void;
  readonly queue: (operation: () => Promise<unknown>) => void;
  readonly flush: (reason?: FlushReason) => Promise<void>;
  boundFiles?: KernelFileSystem;
  threadId?: string;
  facetNonce?: string;
}
const states = new WeakMap<DurableObjectState, FacetState>();
export function facetState(
  ctx: DurableObjectState,
  capability: QualifierCapabilities,
  incarnation: string,
  options: { readonly outputPrefix?: true } = {},
) {
  const existing = states.get(ctx);
  if (existing) {
    assert(existing.facetNonce === incarnation, "Facet state changed incarnation");
    assert(
      existing.outputPrefixEnabled === (options.outputPrefix === true),
      "Facet output capture mode changed incarnation",
    );
    return existing;
  }
  const database: FacetStorage = {
    sql: {
      get databaseSize() {
        return ctx.storage.sql.databaseSize;
      },
      exec: (query, ...bindings) => ctx.storage.sql.exec(query, ...bindings).toArray(),
    },
    transactionSync: (callback) => ctx.storage.transactionSync(callback),
  };
  const reads = observeChunkReads(database);
  let pending = Promise.resolve();
  let failure: unknown;
  const rawOrdinals = new Map<string, number>();
  const stdioPrefix = options.outputPrefix === true ? createNativeStdioPrefix() : undefined;
  const queue = (operation: () => Promise<unknown>) => {
    pending = pending
      .then(async () => {
        await operation();
      })
      .catch((cause) => {
        failure ??= cause;
      });
    ctx.waitUntil(pending);
  };
  const recordRaw = (channel: NativeStdioChannel, bytes: Uint8Array) => {
    const ordinal = (rawOrdinals.get(channel) ?? 0) + 1;
    rawOrdinals.set(channel, ordinal);
    queue(() => capability.recordRaw({ channel, incarnation, ordinal, bytes }));
  };
  const files: HostFiles = {
    identity: "combined-qualifier-files",
    database: reads.storage,
    nowNs: () => BigInt(Date.now()) * 1_000_000n,
    persistencePorts: createMemoryFilePersistencePorts(),
    rootMetadata: { mode: 0o755, uid: 1000, gid: 1000 },
    posix: { credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 }, umask: 0o022 },
    cwd: "/workspace",
    assetMode: 0o644,
  };
  const result: FacetState = {
    files,
    reads,
    rawOrdinals,
    outputPrefixEnabled: options.outputPrefix === true,
    facetNonce: incarnation,
    queue,
    raw(channel, bytes) {
      if (stdioPrefix === undefined) {
        recordRaw(channel, new Uint8Array(bytes));
        return;
      }
      stdioPrefix.write(channel, bytes);
    },
    async flush(reason = "checkpoint") {
      if (stdioPrefix !== undefined) {
        const retained = stdioPrefix.drain(recordRaw);
        queue(() =>
          capability.append("native-stdio-prefix", {
            incarnation,
            reason,
            ...retained,
          }),
        );
      }
      await pending;
      if (failure !== undefined) throw new Error("Native byte capture failed", { cause: failure });
    },
  };
  states.set(ctx, result);
  return result;
}
export function retainedFacetState(ctx: DurableObjectState) {
  const state = states.get(ctx);
  assert(state?.boundFiles && state.threadId, "The product filesystem has not been bound");
  return { ...state, boundFiles: state.boundFiles, threadId: state.threadId };
}
