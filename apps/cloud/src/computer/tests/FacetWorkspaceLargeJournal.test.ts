import { describe, expect, it } from "vite-plus/test";
import { KernelFileSystem, KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import type { CommitInode, ForkCommit } from "../../kernel/FilePersistencePorts.ts";
import {
  base,
  fixtureClock,
  largeJournalRig,
  type CapturedCommit,
  type CapturedFile,
} from "./FacetWorkspaceLargeJournalFixture.ts";

const signal = () => new AbortController().signal;
const MEBIBYTE = 1024 * 1024;

function writeFile(filesystem: KernelFileSystem, path: string, bytes: Uint8Array): void {
  const fd = filesystem.open(path, KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY, 0o644);
  try {
    filesystem.write(fd, bytes, 0n);
  } finally {
    filesystem.close(fd);
  }
}

function readFile(filesystem: KernelFileSystem, path: string, size: number): Uint8Array {
  const fd = filesystem.open(path, KernelOpenFlags.O_RDONLY);
  try {
    const bytes = new Uint8Array(size);
    const count = filesystem.read(fd, bytes, 0n);
    return bytes.slice(0, count);
  } finally {
    filesystem.close(fd);
  }
}

function changedPaths(commit: CapturedCommit): string[] {
  return commit.files.flatMap((file) => file.paths).sort();
}

function assertBoundValuesStayBelowOneMiB(
  boundSqlValueBytes: readonly number[],
  start: number,
): void {
  const sizes = boundSqlValueBytes.slice(start);
  expect(sizes.length).toBeGreaterThan(0);
  const largest = sizes.reduce((maximum, size) => Math.max(maximum, size), 0);
  expect(largest).toBeLessThan(MEBIBYTE);
}

function expectedFileMetadata(
  path: string,
  bytes: Uint8Array,
): Pick<CapturedFile, "paths" | "removedPaths" | "stat" | "symlinkTarget" | "posix" | "content"> {
  const timestamp = fixtureClock().toString();
  return {
    paths: [path],
    removedPaths: [],
    stat: {
      type: "file",
      size: String(bytes.byteLength),
      nlink: "1",
      atimeNs: timestamp,
      mtimeNs: timestamp,
      ctimeNs: timestamp,
    },
    symlinkTarget: null,
    posix: null,
    content: [...bytes],
  };
}

function remoteFile(path: string, bytes: Uint8Array): CommitInode {
  return {
    inode: 9_000_000_001n,
    paths: [path],
    removedPaths: [],
    stat: {
      type: "file",
      size: BigInt(bytes.byteLength),
      nlink: 1n,
      atimeNs: 300n,
      mtimeNs: 301n,
      ctimeNs: 302n,
    },
    symlinkTarget: null,
    posix: { mode: 0o640, uid: 2000, gid: 3000 },
    async *readChunks() {
      yield bytes;
    },
  };
}

describe("facet workspace revision journal integration", () => {
  it("preserves an applied baseline through reconstruction and commits only the local delta", async () => {
    const fixture = largeJournalRig();
    try {
      fixture.seedFlatTree(8);
      const baselineBindings = fixture.boundSqlValueBytes.length;
      const initial = fixture.start(base);
      expect(initial.filesystem.readdir("/")).toHaveLength(8);
      assertBoundValuesStayBelowOneMiB(fixture.boundSqlValueBytes, baselineBindings);

      const appliedPath = "/file-00001.txt";
      const appliedBytes = new Uint8Array([4, 5, 6, 7]);
      fixture.setHydratedFile(appliedPath, appliedBytes);
      const remoteAfter: ForkCommit = { ...base, commit: "remote-after" };
      const applyBindings = fixture.boundSqlValueBytes.length;
      await initial.workspace.apply({
        before: base,
        after: remoteAfter,
        changedInodes: [remoteFile(appliedPath, appliedBytes)],
        hydration: fixture.hydration,
        signal: signal(),
      });
      expect(readFile(initial.filesystem, appliedPath, appliedBytes.byteLength)).toEqual(
        appliedBytes,
      );
      expect(initial.filesystem.getPosixMetadata(appliedPath)).toEqual({
        mode: 0o640,
        uid: 2000,
        gid: 3000,
      });
      assertBoundValuesStayBelowOneMiB(fixture.boundSqlValueBytes, applyBindings);

      const reopened = fixture.restart(remoteAfter);
      const localBytes = new Uint8Array([1, 2, 3]);
      writeFile(reopened.filesystem, "/after-apply.txt", localBytes);
      const afterLocal = await reopened.workspace.checkpoint("after-apply", signal());
      const localCommit = fixture.commitCalls[0]!;
      expect(localCommit.at).toEqual(remoteAfter);
      expect(changedPaths(localCommit)).toEqual(["/after-apply.txt"]);
      expect(localCommit.files).toEqual([
        expect.objectContaining(expectedFileMetadata("/after-apply.txt", localBytes)),
      ]);

      expect(afterLocal.commit).toBe("remote-1");
    } finally {
      fixture.close();
    }
  });

  it("commits only each small turn's delta after persistence reconstruction", async () => {
    const fixture = largeJournalRig();
    try {
      const initial = fixture.start(base);
      const firstBytes = new Uint8Array([7, 8]);
      writeFile(initial.filesystem, "/first-turn.txt", firstBytes);
      const first = await initial.workspace.checkpoint("first-turn", signal());

      expect(fixture.commitCalls[0]?.at).toEqual(base);
      expect(changedPaths(fixture.commitCalls[0]!)).toEqual(["/first-turn.txt"]);
      expect(fixture.commitCalls[0]?.files).toEqual([
        expect.objectContaining(expectedFileMetadata("/first-turn.txt", firstBytes)),
      ]);

      const reopened = fixture.restart(first);
      const secondBytes = new Uint8Array([9]);
      writeFile(reopened.filesystem, "/second-turn.txt", secondBytes);
      const second = await reopened.workspace.checkpoint("second-turn", signal());

      expect(fixture.commitCalls[1]?.at).toEqual(first);
      expect(changedPaths(fixture.commitCalls[1]!)).toEqual(["/second-turn.txt"]);
      expect(fixture.commitCalls[1]?.files).toEqual([
        expect.objectContaining(expectedFileMetadata("/second-turn.txt", secondBytes)),
      ]);
      expect(second.commit).toBe("remote-2");
      expect(readFile(reopened.filesystem, "/first-turn.txt", firstBytes.byteLength)).toEqual(
        firstBytes,
      );
      assertBoundValuesStayBelowOneMiB(fixture.boundSqlValueBytes, 0);
    } finally {
      fixture.close();
    }
  });

  it("rolls back a failed checkpoint publication and retries from the prior baseline", async () => {
    const fixture = largeJournalRig();
    try {
      const initial = fixture.start(base);
      writeFile(initial.filesystem, "/baseline.txt", new Uint8Array([1]));
      const baseline = await initial.workspace.checkpoint("baseline", signal());

      const retryWorkspace = fixture.restart(baseline);
      const retryBytes = new Uint8Array([2, 3]);
      writeFile(retryWorkspace.filesystem, "/retry.txt", retryBytes);
      fixture.failAfterStateUpdate();
      await expect(retryWorkspace.workspace.checkpoint("retry", signal())).rejects.toThrow(
        "injected failure after workspace state update",
      );
      expect(fixture.stateUpdateFaultCount).toBe(1);

      const recovered = fixture.restart(baseline);
      const retry = await recovered.workspace.checkpoint("retry", signal());
      const retryCommit = fixture.commitCalls.find((commit) => commit.turnId === "retry")!;
      expect(retryCommit.at).toEqual(baseline);
      expect(changedPaths(retryCommit)).toEqual(["/retry.txt"]);
      expect(retryCommit.files).toEqual([
        expect.objectContaining(expectedFileMetadata("/retry.txt", retryBytes)),
      ]);
      expect(retry.commit).toBe("remote-2");

      writeFile(recovered.filesystem, "/after-retry.txt", new Uint8Array([4]));
      await recovered.workspace.checkpoint("after-retry", signal());
      expect(fixture.commitCalls.at(-1)?.at).toEqual(retry);
      expect(changedPaths(fixture.commitCalls.at(-1)!)).toEqual(["/after-retry.txt"]);
      assertBoundValuesStayBelowOneMiB(fixture.boundSqlValueBytes, 0);
    } finally {
      fixture.close();
    }
  });
});
