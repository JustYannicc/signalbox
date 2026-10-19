import { describe, expect, it } from "vite-plus/test";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import { fileChange, makeLocalFile, rig } from "./FacetWorkspaceFixture.ts";

const signal = () => new AbortController().signal;

// The first parking candidate for repo:alice:memory-commit-1->memory-commit-2.
const destination = "/.signalbox-apply-oeav51-0";

describe("facet workspace parking path ownership", () => {
  it.each([
    { name: "destination", suffix: "", alias: false },
    { name: "parent directory", suffix: "/child", alias: false },
    { name: "hardlink alias", suffix: "", alias: true },
  ])("allows a remote $name matching a parking candidate", async ({ suffix, alias }) => {
    const fixture = rig([{ path: "/old", bytes: new Uint8Array([1]) }]);
    try {
      const inode = makeLocalFile(fixture.persistence.storage, "/old", new Uint8Array([1]));
      const fd = fixture.filesystem.open("/old", KernelOpenFlags.O_RDONLY);
      const before = await fixture.workspace.checkpoint("collision-before", signal());
      expect(before.commit).toBe("memory-commit-1");
      const path = destination + suffix;
      const changed = fileChange(
        950n,
        alias ? ["/b", path] : [path],
        ["/old"],
        new Uint8Array([9]),
      );
      const committed = await fixture.ports.commits.commit({
        at: before,
        turnId: "collision-remote",
        changedInodes: [changed],
        signal: signal(),
      });
      if (committed.status === "error") throw new Error(committed.error.message);
      expect(committed.value.commit).toBe("memory-commit-2");
      const after = { ...before, commit: committed.value.commit };
      await fixture.workspace.apply({
        before,
        after,
        changedInodes: [changed],
        hydration: fixture.ports.hydration,
        signal: signal(),
      });
      expect(fixture.filesystem.lstat(path).ino).toBe(inode);
      expect(fixture.filesystem.readdir("/").sort()).toEqual(
        alias ? [destination.slice(1), "b"] : [destination.slice(1)],
      );
      if (alias) expect(fixture.filesystem.lstat("/b").ino).toBe(inode);
      expect(fixture.filesystem.fstat(fd).nlink).toBe(alias ? 2n : 1n);
      const actual = new Uint8Array(1);
      expect(fixture.filesystem.read(fd, actual, 0n)).toBe(1);
      expect(actual).toEqual(new Uint8Array([9]));
      fixture.filesystem.close(fd);
      const next = await fixture.workspace.checkpoint("collision-next", signal());
      expect(fixture.ports.inspectTree(next)?.[path]?.data).toEqual(new Uint8Array([9]));
    } finally {
      fixture.close();
    }
  });
});
