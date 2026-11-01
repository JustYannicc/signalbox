import { readRpcData, rpcResourceSnapshot } from "../../../../src/rpc/Resources.ts";
// @effect-diagnostics globalDate:off - The injected filesystem clock is synchronous and runs outside Effect.
import { createMemoryFilePersistencePorts } from "../../../../src/kernel/MemoryFilePersistencePorts.ts";
import type { FacetStorage } from "../../../../src/kernel/FacetSqliteStorage.ts";
import type { KernelFileSystem } from "../../../../src/kernel/KernelFileSystem.ts";
import type { QualifierCapabilities } from "./capabilities.ts";
import type { HostFiles } from "./snapshot.ts";
import { observeChunkReads } from "./chunkReadObserver.ts";
import { assert } from "./common.ts";
import { createNativeStdioCapture, type NativeStdioChannel } from "../../nativeStdio.ts";

type FlushReason = "checkpoint" | "request-settled" | "disposed";
// Raw observers cannot await storage, so bound both queued bytes and queue nodes.
const MAX_PENDING_RAW_BYTES = 1024 * 1024;
const MAX_PENDING_RAW_CHUNKS = 256;

export interface FacetState {
  readonly files: HostFiles;
  readonly reads: ReturnType<typeof observeChunkReads>;
  readonly rawOrdinals: Map<string, number>;
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
  let pendingRawBytes = 0;
  let pendingRawChunks = 0;
  let peakPendingRawBytes = 0;
  let peakPendingRawChunks = 0;
  const resources = () => ({
    scope: "facet-capture-and-cloud-rpc-module" as const,
    pendingRawBytes,
    pendingRawChunks,
    peakPendingRawBytes,
    peakPendingRawChunks,
    databaseBytes:
      typeof ctx.storage.sql.databaseSize === "number" ? ctx.storage.sql.databaseSize : null,
    fileSystemResidentBytes: null,
    reads: reads.counters(),
    rpc: rpcResourceSnapshot(),
  });
  const rawOrdinals = new Map<string, number>();
  const stdioCapture = createNativeStdioCapture();
  const queue = (operation: () => Promise<unknown>) => {
    pending = pending
      .then(async () => {
        await readRpcData(operation());
      })
      .catch((cause) => {
        failure ??= cause;
      });
    try {
      ctx.waitUntil(pending);
    } catch (cause) {
      failure ??= cause;
    }
  };
  const recordRaw = (channel: NativeStdioChannel, bytes: Uint8Array) => {
    if (
      pendingRawBytes + bytes.byteLength > MAX_PENDING_RAW_BYTES ||
      pendingRawChunks >= MAX_PENDING_RAW_CHUNKS
    ) {
      failure ??= new Error("Native byte capture exceeded its pending-memory bound");
      return false;
    }
    const ordinal = (rawOrdinals.get(channel) ?? 0) + 1;
    rawOrdinals.set(channel, ordinal);
    pendingRawBytes += bytes.byteLength;
    pendingRawChunks += 1;
    peakPendingRawBytes = Math.max(peakPendingRawBytes, pendingRawBytes);
    peakPendingRawChunks = Math.max(peakPendingRawChunks, pendingRawChunks);
    const counters = resources();
    queue(async () => {
      try {
        return await capability.recordRaw({
          channel,
          incarnation,
          ordinal,
          bytes,
          resources: counters,
        });
      } finally {
        pendingRawBytes -= bytes.byteLength;
        pendingRawChunks -= 1;
      }
    });
    return true;
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
      stdioCapture.write(channel, bytes, recordRaw);
    },
    async flush(reason = "checkpoint") {
      const streams = stdioCapture.drain();
      queue(() => capability.append("native-stdio-streams", { incarnation, reason, ...streams }));
      queue(() =>
        capability.append("native-resource-counters", {
          incarnation,
          reason,
          ...resources(),
        }),
      );
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

export async function flushFacetDiagnostics(ctx: DurableObjectState, reason: FlushReason) {
  await states.get(ctx)?.flush(reason);
}
