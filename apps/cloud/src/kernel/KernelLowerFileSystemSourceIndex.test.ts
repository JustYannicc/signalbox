import { describe, expect, it } from "vite-plus/test";
import type {
  KernelLowerFileSystemEntry,
  KernelLowerFileSystemSource,
} from "./KernelLowerFileSystem.ts";
import { KernelLowerFileSystemSourceIndex } from "./KernelLowerFileSystemSourceIndex.ts";

function fixture() {
  const entry = (path: string): KernelLowerFileSystemEntry => ({
    path,
    stat: { type: "directory", size: 0n, nlink: 2n, atimeNs: 1n, mtimeNs: 1n, ctimeNs: 1n },
    metadata: { mode: 0o755, uid: 1000, gid: 1000 },
  });
  const entries = [entry("/tmp"), entry("/tmp/existing")];
  const paths = new Map(entries.map((entry) => [entry.path, entry]));
  const calls: string[][] = [];
  const source: KernelLowerFileSystemSource = {
    async lookup(requested) {
      calls.push([...requested]);
      return requested.map((path) => paths.get(path));
    },
    async readdir(path) {
      if (path === "/tmp") return [entries[1]!];
      return undefined;
    },
    async readlink() {
      throw new Error("No symlinks in this fixture");
    },
    async read() {
      throw new Error("No file reads in this fixture");
    },
  };
  let nextInode = 1n;
  return { index: new KernelLowerFileSystemSourceIndex(source, () => nextInode++), calls };
}

describe("KernelLowerFileSystemSourceIndex known absence", () => {
  it("answers every descendant of a known missing parent without consulting the async source", async () => {
    const { index, calls } = fixture();
    await index.prepare(["/tmp"]);
    expect(index.lookupKnown("/tmp/new")).toEqual({ kind: "missing" });
    const before = calls.slice();
    expect(index.lookupKnown("/tmp/new/deep/value")).toEqual({ kind: "missing" });
    expect(await index.lookup("/tmp/new/other/value")).toBeUndefined();
    await index.prepare(["/tmp/new/prepared/value"]);
    expect(calls).toEqual(before);
  });

  it("keeps uncaptured children unknown when their lower parent exists", async () => {
    const { index } = fixture();
    await index.prepare(["/tmp"]);
    expect(index.lookupKnown("/tmp/existing/uncaptured")).toEqual({ kind: "unknown" });
  });

  it("revokes inferred absence when the lower source is invalidated", async () => {
    const { index } = fixture();
    await index.prepare(["/tmp"]);
    expect(index.lookupKnown("/tmp/new")).toEqual({ kind: "missing" });
    expect(index.lookupKnown("/tmp/new/deep/value")).toEqual({ kind: "missing" });
    index.invalidate();
    expect(index.lookupKnown("/tmp/new/deep/value")).toEqual({ kind: "unknown" });
  });
});
