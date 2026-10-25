// @effect-diagnostics cryptoRandomUUID:off - repeated proof invocations need distinct durable turn identities.
import type { ChangedInode } from "./FilePersistencePorts.ts";
import { createFacetFilePersistence } from "./FacetFilePersistence.ts";
import { FILE_CHUNK_BYTES, createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { createMemoryFilePersistencePorts } from "./MemoryFilePersistencePorts.ts";
import { KernelWakeRegistry } from "./KernelAbi.ts";
import { runPosixStorageProof, readPosixStorageProof } from "./PosixStorageProof.ts";
import type { Stat } from "./storage.ts";
import type { FacetStorage } from "./FacetSqliteStorage.ts";

const nowNs = () => 1_800_000_000_000_000_001n;
const persistencePath = "kernel-file-persistence-proof";
const persistenceBytes = new TextEncoder().encode("file-persistence-survived-a-new-request");

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as Error & { readonly code?: unknown }).code)
    : undefined;
}

function statKey(stat: Stat): string {
  return JSON.stringify({
    type: stat.type,
    size: stat.size.toString(),
    nlink: stat.nlink.toString(),
    atimeNs: stat.atimeNs.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  });
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function unlinkIfPresent(
  storage: ReturnType<typeof createFacetFilePersistence>["storage"],
  name: string,
) {
  try {
    storage.unlink(storage.root, name, { directory: false });
  } catch (error) {
    if (codeOf(error) !== "ENOENT") throw error;
  }
}

function releaseIfOpen(
  storage: ReturnType<typeof createFacetFilePersistence>["storage"],
  inode: bigint,
) {
  try {
    storage.release(inode);
  } catch {
    // Proof cleanup must not hide the assertion that failed first.
  }
}

function writePersistenceMarker(storage: ReturnType<typeof createFacetFilePersistence>["storage"]) {
  unlinkIfPresent(storage, persistencePath);
  const inode = storage.create(storage.root, persistencePath, {
    type: "file",
    exclusive: true,
  });
  storage.write(inode, 0n, persistenceBytes);
  storage.release(inode);
}

/** Real request proof for async hydration, turn snapshots, and persisted facet bytes. */
export async function runFilePersistenceProof(database: FacetStorage) {
  const checks: { readonly name: string; readonly ok: true }[] = [];
  const record = (name: string) => checks.push({ name, ok: true });
  const turnId = `kernel-file-persistence-proof-${crypto.randomUUID()}`;
  const at = { repository: "kernel-proof", fork: "main", commit: "proof-base" } as const;
  const source = new Uint8Array(FILE_CHUNK_BYTES + 19);
  for (let index = 0; index < source.byteLength; index++) {
    source[index] = (index * 31 + 7) & 0xff;
  }

  const ports = createMemoryFilePersistencePorts();
  ports.seedFile(at, "/source", source);
  ports.seedFile(at, "/deleted", new Uint8Array([8, 6, 7]));
  let mutateDuringCommit: (() => void) | undefined;
  const persistencePorts = {
    hydration: {
      async fetch(input: Parameters<typeof ports.hydration.fetch>[0]) {
        const result = await ports.hydration.fetch(input);
        if (result.status === "error") return result;
        return {
          status: "ok",
          value: result.value.map((file) => ({
            path: file.path,
            chunks: (async function* () {
              for await (const chunk of file.chunks) {
                yield chunk;
                // A raw wrapper can reopen after bytes are staged, before the next chunk arrives.
                createFacetSqliteStorage(database, nowNs);
              }
            })(),
          })),
        } as const;
      },
    },
    commits: {
      async commit(input: Parameters<typeof ports.commits.commit>[0]) {
        mutateDuringCommit?.();
        return ports.commits.commit(input);
      },
    },
  };

  const wakes = new KernelWakeRegistry();
  const persistence = createFacetFilePersistence(database, nowNs, {
    wakes,
    ports: persistencePorts,
  });
  const storage = persistence.storage;
  checks.push(runPosixStorageProof(storage));
  let completedCommit: string | undefined;
  const retained = new Set<bigint>();
  const hold = (inode: bigint) => (retained.add(inode), inode);
  const release = (inode: bigint) => {
    storage.release(inode);
    retained.delete(inode);
  };

  try {
    for (const name of ["source", "renamed", "alias", "deleted", "symlink", "not-yet"]) {
      unlinkIfPresent(storage, name);
    }
    const sourceInode = hold(
      storage.posix.create(storage.root, "source", {
        type: "file",
        exclusive: true,
        metadata: { mode: 0o644, uid: 1001, gid: 1002 },
      }),
    );
    storage.truncate(sourceInode, BigInt(source.byteLength));
    const before = statKey(storage.stat(sourceInode));
    persistence.markUnhydrated({
      inode: sourceInode,
      path: "/source",
      at,
      size: BigInt(source.byteLength),
    });

    let directCode: string | undefined;
    try {
      storage.readInto(sourceInode, 0n, new Uint8Array(1));
    } catch (error) {
      directCode = codeOf(error);
    }
    assert(
      directCode === "EAGAIN",
      "Guarded storage must not expose an unhydrated inode as zeroes",
    );

    const first = persistence.attempt(() => storage.readInto(sourceInode, 0n, new Uint8Array(1)));
    assert(first.status === "would_block", "The first read must return WOULD_BLOCK");
    const wake = await wakes.wait(first.wakeToken);
    assert(wake.status === "ok", "Hydration wake failed");

    const hydrated = new Uint8Array(source.byteLength);
    const retry = persistence.attempt(() => storage.readInto(sourceInode, 0n, hydrated));
    assert(retry.status === "ok", "Retry after hydration did not complete");
    assert(retry.value === source.byteLength, "Hydration returned the wrong byte count");
    assert(equalBytes(hydrated, source), "Hydration changed file bytes across a chunk boundary");
    assert(statKey(storage.stat(sourceInode)) === before, "Hydration changed inode metadata");
    assert(storage.posix.get(sourceInode).uid === 1001, "Hydration changed POSIX ownership");
    assert(ports.fetchCalls.length === 1, "One inode read must share one remote fetch");
    record("unhydrated read blocks, fetches exact bytes, and preserves metadata");

    storage.write(sourceInode, 0n, new Uint8Array([0xf0, 0x0d]));
    storage.rename(storage.root, "source", storage.root, "renamed");
    storage.link(sourceInode, storage.root, "alias");

    const deletedInode = hold(
      storage.create(storage.root, "deleted", { type: "file", exclusive: true }),
    );
    storage.write(deletedInode, 0n, new Uint8Array([1]));
    storage.unlink(storage.root, "deleted", { directory: false });
    release(deletedInode);

    const symlinkInode = hold(
      storage.create(storage.root, "symlink", {
        type: "symlink",
        exclusive: true,
        target: "renamed",
      }),
    );
    const changedInodes: readonly ChangedInode[] = [
      { inode: sourceInode, paths: ["/renamed", "/alias"], removedPaths: ["/source"] },
      { inode: deletedInode, paths: [], removedPaths: ["/deleted"] },
      { inode: symlinkInode, paths: ["/symlink"], removedPaths: [] },
    ];
    const expected = source.slice();
    expected[0] = 0xf0;
    expected[1] = 0x0d;
    const changedAfterSnapshot = source[source.byteLength - 1]! ^ 0xff;
    mutateDuringCommit = () => {
      storage.write(
        sourceInode,
        BigInt(source.byteLength - 1),
        new Uint8Array([changedAfterSnapshot]),
      );
      storage.posix.chmod(sourceInode, 0o600);
      storage.posix.chown(sourceInode, { uid: 3, gid: 4 });
    };
    const receipt = await persistence.commitTurn({
      at,
      turnId,
      changedInodes,
      signal: new AbortController().signal,
    });
    assert(receipt.status === "ok", "Turn commit did not return a receipt");
    completedCommit = receipt.value.commit;
    const committedAt = { ...at, commit: receipt.value.commit };
    const tree = ports.inspectTree(committedAt);
    assert(tree !== undefined, "The commit receipt did not identify a stored tree");
    const renamed = tree["/renamed"];
    const alias = tree["/alias"];
    const link = tree["/symlink"];
    assert(
      renamed !== undefined && renamed.data instanceof Uint8Array,
      "Renamed file data is missing",
    );
    assert(alias !== undefined && alias.data instanceof Uint8Array, "Hard link data is missing");
    assert(equalBytes(renamed.data, expected), "The commit snapshot lost file edits");
    assert(equalBytes(alias.data, expected), "Hard links did not commit the same inode bytes");
    assert(
      renamed.posix?.mode === 0o644 && renamed.posix.uid === 1001 && renamed.posix.gid === 1002,
      "The commit snapshot lost POSIX metadata while the live inode changed",
    );
    assert(
      alias.posix?.mode === renamed.posix.mode && alias.posix.uid === renamed.posix.uid,
      "Hard links did not commit the same POSIX metadata",
    );
    const liveFinalByte = new Uint8Array(1);
    assert(
      storage.readInto(sourceInode, BigInt(source.byteLength - 1), liveFinalByte) === 1 &&
        liveFinalByte[0] === changedAfterSnapshot,
      "The live inode did not change during the commit stream",
    );
    assert(!Object.hasOwn(tree, "/source"), "Rename left the old path in the committed tree");
    assert(!Object.hasOwn(tree, "/deleted"), "Delete left the removed path in the committed tree");
    assert(
      link?.stat.type === "symlink" && link.symlinkTarget === "renamed",
      "Symlink metadata was not committed",
    );
    assert(ports.committedTurns.length === 1, "The memory port did not record the turn receipt");
    record("turn snapshot stays stable while committing edits, namespace changes, and symlink");

    writePersistenceMarker(storage);
    release(sourceInode);
    release(symlinkInode);
  } finally {
    persistence.dispose();
    for (const inode of retained) releaseIfOpen(storage, inode);
    wakes.dispose();
  }

  // Release the first controller before installing the default adapter on this facet database.
  const missingWakes = new KernelWakeRegistry();
  const missing = createFacetFilePersistence(database, nowNs, { wakes: missingWakes });
  const unavailable = missing.storage.create(missing.storage.root, "not-yet", {
    type: "file",
    exclusive: true,
  });
  missing.storage.truncate(unavailable, 1n);
  missing.markUnhydrated({
    inode: unavailable,
    path: "/not-yet",
    at,
    size: 1n,
  });
  try {
    const replay = await missing.commitTurn({
      at,
      turnId,
      changedInodes: [{ inode: unavailable, paths: ["/not-yet"], removedPaths: [] }],
      signal: new AbortController().signal,
    });
    assert(
      replay.status === "ok" && replay.value.commit === completedCommit,
      "Completed turn replay must ignore new unhydrated files after controller reconstruction",
    );
    const first = missing.attempt(() =>
      missing.storage.readInto(unavailable, 0n, new Uint8Array(1)),
    );
    assert(first.status === "would_block", "Missing adapter must first return WOULD_BLOCK");
    assert(
      (await missingWakes.wait(first.wakeToken)).status === "ok",
      "Missing adapter wake failed",
    );
    const retry = missing.attempt(() =>
      missing.storage.readInto(unavailable, 0n, new Uint8Array(1)),
    );
    assert(
      retry.status === "error" && retry.error.code === "UNSUPPORTED",
      "The typed not-yet adapter must fail explicitly as UNSUPPORTED",
    );
    record(
      "completed receipt replays before hydration and the unconfigured adapter reports UNSUPPORTED",
    );
  } finally {
    missing.dispose();
    try {
      missing.storage.unlink(missing.storage.root, "not-yet", { directory: false });
    } catch {
      // Cleanup only; the proof result is the assertion above.
    }
    releaseIfOpen(missing.storage, unavailable);
    missingWakes.dispose();
  }

  return { ok: true, checks };
}

/** Read in a fresh controller/request to prove local facet bytes survive reconstruction. */
export function readFilePersistenceProof(database: FacetStorage) {
  const wakes = new KernelWakeRegistry();
  const persistence = createFacetFilePersistence(database, nowNs, { wakes });
  try {
    const inode = persistence.storage.lookup(persistence.storage.root, persistencePath);
    const actual = new Uint8Array(persistenceBytes.byteLength);
    const count = persistence.storage.readInto(inode, 0n, actual);
    assert(count === persistenceBytes.byteLength, "Persisted file length changed across requests");
    assert(equalBytes(actual, persistenceBytes), "Persisted file bytes changed across requests");
    return {
      ok: true,
      checks: [
        { name: "facet file bytes survived a new request", ok: true },
        readPosixStorageProof(persistence.storage),
      ],
    };
  } finally {
    persistence.dispose();
    wakes.dispose();
  }
}
