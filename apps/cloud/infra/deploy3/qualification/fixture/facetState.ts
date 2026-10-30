// @effect-diagnostics globalDate:off - The injected filesystem clock is synchronous and runs outside Effect.
import { createMemoryFilePersistencePorts } from "../../../../src/kernel/MemoryFilePersistencePorts.ts";
import type { FacetStorage } from "../../../../src/kernel/FacetSqliteStorage.ts";
import type { KernelFileSystem } from "../../../../src/kernel/KernelFileSystem.ts";
import type { QualifierCapabilities } from "./capabilities.ts";
import type { HostFiles } from "./snapshot.ts";
import { observeChunkReads } from "./chunkReadObserver.ts";
import { assert } from "./common.ts";

export interface FacetState {
  readonly files: HostFiles;
  readonly reads: ReturnType<typeof observeChunkReads>;
  readonly rawOrdinals: Map<string, number>;
  readonly raw: (
    channel: "native-stdin" | "native-stdout" | "native-stderr",
    bytes: Uint8Array,
  ) => void;
  readonly queue: (operation: () => Promise<unknown>) => void;
  readonly flush: () => Promise<void>;
  boundFiles?: KernelFileSystem;
  threadId?: string;
  facetNonce?: string;
}
const states = new WeakMap<DurableObjectState, FacetState>();
export function facetState(
  ctx: DurableObjectState,
  capability: QualifierCapabilities,
  incarnation: string,
) {
  const existing = states.get(ctx);
  if (existing) {
    assert(existing.facetNonce === incarnation, "Facet state changed incarnation");
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
    facetNonce: incarnation,
    queue,
    raw(channel, bytes) {
      const ordinal = (rawOrdinals.get(channel) ?? 0) + 1;
      rawOrdinals.set(channel, ordinal);
      const captured = new Uint8Array(bytes);
      queue(() => capability.recordRaw({ channel, incarnation, ordinal, bytes: captured }));
    },
    async flush() {
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
