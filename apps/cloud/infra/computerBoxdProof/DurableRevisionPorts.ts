import * as Schema from "effect/Schema";
import type { FilePersistencePorts, ForkCommit } from "../../src/kernel/FilePersistencePorts.ts";
import { FILE_CHUNK_BYTES, type FacetStorage } from "../../src/kernel/FacetSqliteStorage.ts";
import { isPosixMetadata } from "../../src/kernel/PosixStorage.ts";

const PATH = "/out.bin";
const LIMIT = 16 * 1024 * 1024;
const Metadata = Schema.fromJsonString(
  Schema.Struct({
    inode: Schema.BigIntFromString,
    stat: Schema.Struct({
      type: Schema.Literal("file"),
      size: Schema.BigIntFromString,
      nlink: Schema.BigIntFromString,
      atimeNs: Schema.BigIntFromString,
      mtimeNs: Schema.BigIntFromString,
      ctimeNs: Schema.BigIntFromString,
    }),
    symlinkTarget: Schema.Null,
    posix: Schema.optional(
      Schema.NullOr(Schema.Struct({ mode: Schema.Number, uid: Schema.Number, gid: Schema.Number })),
    ),
  }),
);
const encode = Schema.encodeSync(Metadata);
const decode = Schema.decodeUnknownSync(Metadata);
const failure = (code: "NOT_FOUND" | "STALE_COMMIT" | "CANCELLED" | "IO_ERROR", message: string) =>
  ({ status: "error", error: { code, message } }) as const;

/** SQLite proof repository for one regular /out.bin of at most 16 MiB, not a Drive backend. */
export function createDurableProofRevisionPorts(storage: FacetStorage) {
  const exec = (query: string, ...bindings: (string | number | null | ArrayBuffer)[]) =>
    Array.from(storage.sql.exec(query, ...bindings));
  storage.transactionSync(() => {
    exec(
      "CREATE TABLE IF NOT EXISTS proof_revision (id INTEGER PRIMARY KEY, repository TEXT NOT NULL, fork TEXT NOT NULL, commit_id TEXT NOT NULL, metadata TEXT, UNIQUE(repository, fork, commit_id))",
    );
    exec(
      "CREATE TABLE IF NOT EXISTS proof_revision_chunk (revision INTEGER NOT NULL, ordinal INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(revision, ordinal))",
    );
    exec(
      "CREATE TABLE IF NOT EXISTS proof_revision_head (repository TEXT NOT NULL, fork TEXT NOT NULL, commit_id TEXT NOT NULL, PRIMARY KEY(repository, fork))",
    );
    exec(
      "CREATE TABLE IF NOT EXISTS proof_revision_turn (repository TEXT NOT NULL, fork TEXT NOT NULL, before_id TEXT NOT NULL, turn_id TEXT NOT NULL, after_id TEXT NOT NULL, PRIMARY KEY(repository, fork, before_id, turn_id))",
    );
  });
  const lookup = (at: ForkCommit) =>
    exec(
      "SELECT * FROM proof_revision WHERE repository = ? AND fork = ? AND commit_id = ?",
      at.repository,
      at.fork,
      at.commit,
    )[0];
  const receipt = (at: ForkCommit, turnId: string) => {
    const row = exec(
      "SELECT after_id FROM proof_revision_turn WHERE repository = ? AND fork = ? AND before_id = ? AND turn_id = ?",
      at.repository,
      at.fork,
      at.commit,
      turnId,
    )[0];
    return row ? ({ status: "ok", value: { commit: String(row.after_id) } } as const) : undefined;
  };
  const nextId = () =>
    Number(exec("SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM proof_revision")[0]?.next_id);
  const tree = (at: ForkCommit) => {
    const row = lookup(at);
    if (!row) return undefined;
    if (row.metadata === null) return {};
    const metadata = decode(row.metadata);
    const data = new Uint8Array(Number(metadata.stat.size));
    let offset = 0;
    for (const chunk of exec(
      "SELECT bytes FROM proof_revision_chunk WHERE revision = ? ORDER BY ordinal",
      Number(row.id),
    )) {
      const bytes = chunk.bytes instanceof ArrayBuffer ? new Uint8Array(chunk.bytes) : chunk.bytes;
      if (!(bytes instanceof Uint8Array)) throw new Error("Invalid proof revision chunk");
      data.set(bytes, offset);
      offset += bytes.byteLength;
    }
    if (offset !== data.byteLength) throw new Error("Incomplete proof revision");
    return { [PATH]: { ...metadata, data } };
  };
  const insert = (id: number, at: ForkCommit, metadata: string | null, data: Uint8Array | null) => {
    exec(
      "INSERT INTO proof_revision (id, repository, fork, commit_id, metadata) VALUES (?, ?, ?, ?, ?)",
      id,
      at.repository,
      at.fork,
      at.commit,
      metadata,
    );
    for (let offset = 0; offset < (data?.byteLength ?? 0); offset += FILE_CHUNK_BYTES)
      exec(
        "INSERT INTO proof_revision_chunk (revision, ordinal, bytes) VALUES (?, ?, ?)",
        id,
        offset / FILE_CHUNK_BYTES,
        data!.slice(offset, offset + FILE_CHUNK_BYTES).buffer,
      );
    exec(
      "INSERT INTO proof_revision_head (repository, fork, commit_id) VALUES (?, ?, ?) ON CONFLICT(repository, fork) DO UPDATE SET commit_id = excluded.commit_id",
      at.repository,
      at.fork,
      at.commit,
    );
  };
  const ports: FilePersistencePorts = {
    hydration: {
      async fetch({ at, paths, signal }) {
        if (signal.aborted) return failure("CANCELLED", "Proof hydration cancelled");
        try {
          const snapshot = storage.transactionSync(() => tree(at));
          if (!snapshot || paths.some((path) => path !== PATH || !snapshot[PATH]))
            return failure("NOT_FOUND", "Proof revision file was not found");
          return {
            status: "ok",
            value: paths.map((path) => ({
              path,
              chunks: (async function* () {
                const data = snapshot[PATH]!.data;
                for (let offset = 0; offset < data.byteLength; offset += FILE_CHUNK_BYTES) {
                  signal.throwIfAborted();
                  yield data.slice(offset, offset + FILE_CHUNK_BYTES);
                }
              })(),
            })),
          } as const;
        } catch {
          return failure("IO_ERROR", "Proof revision could not be hydrated");
        }
      },
    },
    commits: {
      async commit({ at, turnId, changedInodes, signal }) {
        if (signal.aborted) return failure("CANCELLED", "Proof commit cancelled");
        try {
          const original = storage.transactionSync(() => receipt(at, turnId));
          if (original) return original;
          if (changedInodes.length > 1) throw new Error("Proof supports one changed inode");
          const base = storage.transactionSync(() => tree(at));
          if (!base) return failure("NOT_FOUND", "Proof base revision was not found");
          let entry = base[PATH];
          for (const changed of changedInodes) {
            if (
              changed.paths.length > 1 ||
              changed.removedPaths.length > 1 ||
              changed.paths.length + changed.removedPaths.length === 0 ||
              [...changed.paths, ...changed.removedPaths].some((path) => path !== PATH)
            )
              throw new Error("Proof supports only /out.bin without aliases");
            if (!changed.stat || changed.paths.length === 0) {
              entry = undefined;
              continue;
            }
            if (
              changed.stat.type !== "file" ||
              changed.stat.size < 0n ||
              changed.stat.size > BigInt(LIMIT) ||
              changed.stat.nlink !== 1n ||
              changed.inode <= 0n ||
              changed.symlinkTarget !== null ||
              (changed.posix != null && !isPosixMetadata(changed.posix))
            )
              throw new Error("Proof supports one bounded regular file");
            const metadata = decode(
              encode({
                inode: changed.inode,
                stat: { ...changed.stat, type: "file" },
                symlinkTarget: null,
                ...(changed.posix === undefined ? {} : { posix: changed.posix }),
              }),
            );
            const data = new Uint8Array(Number(metadata.stat.size));
            let offset = 0;
            for await (const chunk of changed.readChunks()) {
              signal.throwIfAborted();
              if (!(chunk instanceof Uint8Array) || offset + chunk.byteLength > data.byteLength)
                throw new Error("Invalid proof file chunks");
              data.set(chunk, offset);
              offset += chunk.byteLength;
            }
            if (offset !== data.byteLength) throw new Error("Incomplete proof file chunks");
            entry = { ...metadata, data };
          }
          signal.throwIfAborted();
          return storage.transactionSync(() => {
            const replay = receipt(at, turnId);
            if (replay) return replay;
            const head = exec(
              "SELECT commit_id FROM proof_revision_head WHERE repository = ? AND fork = ?",
              at.repository,
              at.fork,
            )[0];
            if (head?.commit_id !== at.commit)
              return failure("STALE_COMMIT", "Proof fork has advanced");
            const id = nextId();
            if (!Number.isSafeInteger(id)) throw new Error("Proof revision sequence exhausted");
            const commit = `durable-proof-${id}`;
            insert(id, { ...at, commit }, entry ? encode(entry) : null, entry?.data ?? null);
            exec(
              "INSERT INTO proof_revision_turn (repository, fork, before_id, turn_id, after_id) VALUES (?, ?, ?, ?, ?)",
              at.repository,
              at.fork,
              at.commit,
              turnId,
              commit,
            );
            return { status: "ok", value: { commit } } as const;
          });
        } catch {
          return signal.aborted
            ? failure("CANCELLED", "Proof commit cancelled")
            : failure("IO_ERROR", "Proof revision commit failed");
        }
      },
    },
  };
  return {
    ...ports,
    seedFile(at: ForkCommit, path: string, bytes: Uint8Array) {
      if (path !== PATH || bytes.byteLength > LIMIT || at.commit.startsWith("durable-proof-"))
        throw new Error("Invalid one-file proof seed");
      storage.transactionSync(() => {
        const existing = tree(at);
        if (existing) {
          const data = existing[PATH]?.data;
          if (
            !data ||
            data.byteLength !== bytes.byteLength ||
            !data.every((byte, index) => byte === bytes[index])
          )
            throw new Error("Immutable proof seed changed");
          return;
        }
        if (
          exec(
            "SELECT commit_id FROM proof_revision_head WHERE repository = ? AND fork = ?",
            at.repository,
            at.fork,
          ).length
        )
          throw new Error("Proof fork already exists");
        insert(
          nextId(),
          at,
          encode({
            inode: 1n,
            stat: {
              type: "file",
              size: BigInt(bytes.byteLength),
              nlink: 1n,
              atimeNs: 0n,
              mtimeNs: 0n,
              ctimeNs: 0n,
            },
            symlinkTarget: null,
          }),
          bytes.slice(),
        );
      });
    },
    inspectTree: (at: ForkCommit) => storage.transactionSync(() => tree(at)),
    get committedTurns() {
      return storage.transactionSync(() =>
        exec("SELECT * FROM proof_revision_turn ORDER BY rowid").map((row) => {
          const at = {
            repository: String(row.repository),
            fork: String(row.fork),
            commit: String(row.before_id),
          };
          const commit = String(row.after_id);
          return {
            at,
            turnId: String(row.turn_id),
            receipt: { commit },
            tree: tree({ ...at, commit })!,
          };
        }),
      );
    },
  };
}
