import { describe, expect, it } from "vite-plus/test";
import { createFacetFilePersistence } from "../../kernel/FacetFilePersistence.ts";
import type {
  FileCommitPort,
  FilePersistencePorts,
  ForkCommit,
} from "../../kernel/FilePersistencePorts.ts";
import { createMemoryFilePersistencePorts } from "../../kernel/MemoryFilePersistencePorts.ts";
import { KernelWakeRegistry } from "../../kernel/KernelAbi.ts";
import { KernelFileSystem, KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import { createFacetWorkspace } from "../FacetWorkspace.ts";
import { sqliteFixture } from "./helpers/sqliteFixture.ts";

const base: ForkCommit = { repository: "repo", fork: "alice", commit: "fork-1" };
const initialFiles = [
  { path: "/project/kept.txt", bytes: new Uint8Array([1, 2, 3]) },
  { path: "/project/also-kept.txt", bytes: new Uint8Array([4, 5]) },
] as const;
const clock = () => 1_800_000_000_000_000_001n;
const signal = () => new AbortController().signal;

interface CapturedCommit {
  readonly at: ForkCommit;
  readonly turnId: string;
  readonly entries: readonly {
    readonly paths: readonly string[];
    readonly removedPaths: readonly string[];
    readonly type: "file" | "directory" | "symlink" | null;
  }[];
}

function fixture() {
  const database = sqliteFixture();
  const wakes = new KernelWakeRegistry();
  const remote = createMemoryFilePersistencePorts();
  const calls: CapturedCommit[] = [];
  let failNextCommit = false;

  for (const file of initialFiles) remote.seedFile(base, file.path, file.bytes);

  const commits: FileCommitPort = {
    async commit(input) {
      calls.push({
        at: { ...input.at },
        turnId: input.turnId,
        entries: input.changedInodes.map((entry) => ({
          paths: [...entry.paths],
          removedPaths: [...entry.removedPaths],
          type: entry.stat?.type ?? null,
        })),
      });
      if (failNextCommit) {
        failNextCommit = false;
        return {
          status: "error",
          error: { code: "IO_ERROR", message: "simulated remote commit failure" },
        };
      }
      return remote.commits.commit(input);
    },
  };
  const ports: FilePersistencePorts = { hydration: remote.hydration, commits };
  const persistence = createFacetFilePersistence(database.storage, clock, { wakes, ports });

  const directory = persistence.storage.create(persistence.storage.root, "project", {
    type: "directory",
    exclusive: true,
  });
  persistence.storage.posix.initialize(directory, { mode: 0o755, uid: 1000, gid: 1000 });
  for (const file of initialFiles) {
    const name = file.path.slice("/project/".length);
    const inode = persistence.storage.create(directory, name, { type: "file", exclusive: true });
    persistence.storage.write(inode, 0n, file.bytes);
    persistence.storage.posix.initialize(inode, { mode: 0o644, uid: 1000, gid: 1000 });
  }

  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: persistence.storage }],
    cwd: "/",
  });
  const createWorkspace = () =>
    createFacetWorkspace({
      database: database.storage,
      persistence,
      filesystem,
      mountPath: "/",
      initial: base,
      mount: async () => {
        throw new Error("The external machine mount is outside this adapter test");
      },
    });

  const workspace = createWorkspace();

  return {
    filesystem,
    remote,
    calls,
    workspace,
    createWorkspace,
    failNextCommit() {
      failNextCommit = true;
    },
    close() {
      filesystem.dispose();
      persistence.dispose();
      wakes.dispose();
      database.close();
    },
  };
}

function writeFile(filesystem: KernelFileSystem, path: string, bytes: Uint8Array): void {
  const fd = filesystem.open(path, KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY, 0o644);
  try {
    filesystem.write(fd, bytes, 0n);
  } finally {
    filesystem.close(fd);
  }
}

function changedEntries(call: CapturedCommit) {
  return call.entries
    .map((entry) => ({
      path: entry.paths[0] ?? entry.removedPaths[0] ?? "",
      type: entry.type,
      removedPaths: entry.removedPaths,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

const expectedDelta = (name: string) => [
  { path: "/project", type: "directory", removedPaths: [] },
  { path: `/project/${name}`, type: "file", removedPaths: [] },
];

describe("facet workspace committed baseline", () => {
  it("commits only each turn's delta after recreating the workspace", async () => {
    const test = fixture();
    try {
      writeFile(test.filesystem, "/project/first-turn.txt", new Uint8Array([7, 8]));
      const first = await test.workspace.checkpoint("first-turn", signal());

      expect(test.calls).toHaveLength(1);
      expect(test.calls[0]?.at).toEqual(base);
      expect(changedEntries(test.calls[0]!)).toEqual(expectedDelta("first-turn.txt"));
      expect(test.remote.inspectTree(first)?.["/project/kept.txt"]?.data).toEqual(
        initialFiles[0].bytes,
      );
      expect(test.remote.inspectTree(first)?.["/project/also-kept.txt"]?.data).toEqual(
        initialFiles[1].bytes,
      );
      expect(test.remote.inspectTree(first)?.["/project/first-turn.txt"]?.data).toEqual(
        new Uint8Array([7, 8]),
      );

      const reopened = test.createWorkspace();
      writeFile(test.filesystem, "/project/second-turn.txt", new Uint8Array([9]));
      const second = await reopened.checkpoint("second-turn", signal());

      expect(test.calls).toHaveLength(2);
      expect(test.calls[1]?.at).toEqual(first);
      expect(changedEntries(test.calls[1]!)).toEqual(expectedDelta("second-turn.txt"));
      expect(test.remote.inspectTree(second)?.["/project/first-turn.txt"]?.data).toEqual(
        new Uint8Array([7, 8]),
      );
      expect(test.remote.inspectTree(second)?.["/project/second-turn.txt"]?.data).toEqual(
        new Uint8Array([9]),
      );
    } finally {
      test.close();
    }
  });

  it("keeps the committed baseline after a failed save and retry", async () => {
    const test = fixture();
    try {
      writeFile(test.filesystem, "/project/baseline-turn.txt", new Uint8Array([3]));
      const first = await test.workspace.checkpoint("baseline-turn", signal());
      expect(changedEntries(test.calls[0]!)).toEqual(expectedDelta("baseline-turn.txt"));
      const reopened = test.createWorkspace();
      writeFile(test.filesystem, "/project/retry-turn.txt", new Uint8Array([10, 11]));
      test.failNextCommit();

      await expect(reopened.checkpoint("retry-turn", signal())).rejects.toThrow(
        "simulated remote commit failure",
      );

      expect(test.calls).toHaveLength(2);
      expect(test.calls[1]?.at).toEqual(first);
      expect(changedEntries(test.calls[1]!)).toEqual(expectedDelta("retry-turn.txt"));
      expect(test.remote.committedTurns).toHaveLength(1);

      const afterRestart = test.createWorkspace();
      const retry = await afterRestart.checkpoint("retry-turn", signal());

      expect(retry).not.toEqual(first);
      expect(test.calls).toHaveLength(3);
      expect(test.calls[2]?.at).toEqual(first);
      expect(changedEntries(test.calls[2]!)).toEqual(expectedDelta("retry-turn.txt"));
      expect(test.remote.committedTurns).toHaveLength(2);
      expect(test.remote.inspectTree(retry)?.["/project/retry-turn.txt"]?.data).toEqual(
        new Uint8Array([10, 11]),
      );
    } finally {
      test.close();
    }
  });
});
