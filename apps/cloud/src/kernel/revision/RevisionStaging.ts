import type { FileHydrationPort, ForkCommit } from "../FilePersistencePorts.ts";
import type { Inode } from "../storage.ts";
import type { FacetStorage } from "../FacetSqliteStorage.ts";
import type { createFacetFilePersistence } from "../FacetFilePersistence.ts";
import { KernelRevisionWorkspaceError, persistenceError } from "./RevisionErrors.ts";
import type { ApplyPlan, Persistence } from "./RevisionTypes.ts";

export async function stageFiles(
  database: FacetStorage,
  hydration: FileHydrationPort,
  after: ForkCommit,
  applyId: string,
  plans: readonly ApplyPlan[],
  signal: AbortSignal,
): Promise<void> {
  const files = plans.filter((plan) => plan.changed.stat?.type === "file");
  const paths = files.map((plan) => plan.changed.paths[0]!);
  if (paths.length === 0) return;
  database.sql.exec("DELETE FROM kernel_fs_workspace_apply_chunk WHERE apply_id = ?", applyId);
  const result = await hydration.fetch({ at: after, paths, signal });
  if (result.status === "error") throw persistenceError(result);
  if (result.value.length !== paths.length)
    throw new KernelRevisionWorkspaceError(
      "IO_ERROR",
      "Hydration did not return every changed file",
    );
  const byPath = new Map(files.map((plan) => [plan.changed.paths[0]!, plan.changed]));
  const seen = new Set<string>();
  for (const file of result.value) {
    const entry = byPath.get(file.path);
    if (!entry || seen.has(file.path))
      throw new KernelRevisionWorkspaceError(
        "IO_ERROR",
        "Hydration returned an unexpected changed path",
      );
    seen.add(file.path);
    let received = 0n;
    let part = 0;
    let buffered = 0;
    const block = new Uint8Array(64 * 1024);
    const persistBlock = (bytes: Uint8Array) => {
      const blob = bytes.slice().buffer as ArrayBuffer;
      database.sql.exec(
        "INSERT INTO kernel_fs_workspace_apply_chunk VALUES (?, ?, ?, ?)",
        applyId,
        entry.inode.toString(),
        part++,
        blob,
      );
    };
    for await (const chunk of file.chunks) {
      signal.throwIfAborted();
      if (!(chunk instanceof Uint8Array))
        throw new KernelRevisionWorkspaceError("IO_ERROR", "Hydration returned a non-byte chunk");
      received += BigInt(chunk.byteLength);
      if (received > entry.stat!.size)
        throw new KernelRevisionWorkspaceError(
          "IO_ERROR",
          "Hydration exceeded the declared file size",
        );
      let offset = 0;
      while (offset < chunk.byteLength) {
        const copied = Math.min(block.byteLength - buffered, chunk.byteLength - offset);
        block.set(chunk.subarray(offset, offset + copied), buffered);
        buffered += copied;
        offset += copied;
        if (buffered === block.byteLength) {
          persistBlock(block);
          buffered = 0;
        }
      }
    }
    if (buffered > 0) persistBlock(block.subarray(0, buffered));
    if (received !== entry.stat!.size)
      throw new KernelRevisionWorkspaceError(
        "IO_ERROR",
        "Hydration did not match the declared file size",
      );
  }
}

export async function hydratePendingCandidates(
  storage: Persistence["storage"],
  persistence: ReturnType<typeof createFacetFilePersistence>,
  plans: readonly ApplyPlan[],
  signal: AbortSignal,
): Promise<void> {
  const seen = new Set<Inode>();
  for (const plan of plans) {
    if (
      plan.changed.stat?.type !== "file" ||
      plan.localInode === undefined ||
      seen.has(plan.localInode)
    )
      continue;
    seen.add(plan.localInode);
    signal.throwIfAborted();
    await persistence.runLeaf(
      () => storage.readInto(plan.localInode!, 0n, new Uint8Array(0)),
      signal,
    );
  }
}
