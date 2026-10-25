import { describe, expect, it } from "vite-plus/test";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import type { CommitInode, ForkCommit } from "../../kernel/FilePersistencePorts.ts";
import {
  commitPort,
  directoryChange,
  fileChange,
  makeLocalFile,
  makeLocalPath,
  rig,
} from "./FacetWorkspaceFixture.ts";

const signal = () => new AbortController().signal;

async function commit(
  fixture: ReturnType<typeof rig>,
  at: ForkCommit,
  turnId: string,
  changedInodes: readonly CommitInode[],
): Promise<ForkCommit> {
  const result = await commitPort(fixture.ports).commit({
    at,
    turnId,
    changedInodes,
    signal: signal(),
  });
  if (result.status === "error") throw new Error(result.error.message);
  return { ...at, commit: result.value.commit };
}

describe("kernel revision namespace identity parking", () => {
  it("keeps replaced file identities for cross-depth renames in either plan order", async () => {
    for (const reverse of [false, true]) {
      const fixture = rig([{ path: "/old", bytes: new Uint8Array([1]) }]);
      try {
        const original = makeLocalFile(fixture.persistence.storage, "/old", new Uint8Array([1]));
        const before = await fixture.workspace.checkpoint(
          `file-cross-depth-before-${reverse}`,
          signal(),
        );
        const fd = fixture.filesystem.open("/old", KernelOpenFlags.O_RDONLY);
        const replacement = fileChange(230n, ["/old"], [], new Uint8Array([9]));
        const renamed = fileChange(231n, ["/deep/moved"], ["/old"], new Uint8Array([7]));
        const parent = directoryChange(232n, "/deep", []);
        const changed = reverse ? [renamed, replacement, parent] : [replacement, parent, renamed];
        const result = await commit(fixture, before, `file-cross-depth-after-${reverse}`, changed);

        await fixture.workspace.apply({
          before,
          after: result,
          changedInodes: changed,
          hydration: fixture.ports.hydration,
          signal: signal(),
        });

        expect(fixture.filesystem.lstat("/deep/moved").ino).toBe(original);
        expect(fixture.filesystem.lstat("/old").ino).not.toBe(original);
        const descriptorBytes = new Uint8Array(1);
        fixture.filesystem.read(fd, descriptorBytes, 0n);
        expect(descriptorBytes).toEqual(new Uint8Array([7]));
        expect(fixture.ports.inspectTree(result)?.["/old"]?.data).toEqual(new Uint8Array([9]));
        expect(fixture.ports.inspectTree(result)?.["/deep/moved"]?.data).toEqual(
          new Uint8Array([7]),
        );
        fixture.filesystem.close(fd);
      } finally {
        fixture.close();
      }
    }
  });

  it("keeps empty and populated directory identities for cross-depth replacement in either order", async () => {
    for (const populated of [false, true]) {
      for (const reverse of [false, true]) {
        const childBytes = new Uint8Array([1, 2]);
        const fixture = rig(
          populated
            ? [{ path: "/old/file", bytes: childBytes }]
            : [{ path: "/seed", bytes: new Uint8Array([0]) }],
        );
        try {
          let directory: bigint;
          if (!populated) makeLocalFile(fixture.persistence.storage, "/seed", new Uint8Array([0]));
          if (populated) {
            makeLocalPath(fixture.persistence.storage, "/old/file", childBytes);
            directory = fixture.filesystem.lstat("/old").ino;
          } else {
            fixture.filesystem.mkdir("/old");
            directory = fixture.filesystem.lstat("/old").ino;
          }
          const child = populated ? fixture.filesystem.lstat("/old/file").ino : undefined;
          const before = await fixture.workspace.checkpoint(
            `directory-cross-depth-before-${populated}-${reverse}`,
            signal(),
          );
          const replacement = directoryChange(233n, "/old", []);
          const renamed = directoryChange(234n, "/deep/moved", ["/old"]);
          const parent = directoryChange(235n, "/deep", []);
          const file = populated
            ? fileChange(236n, ["/deep/moved/file"], ["/old/file"], new Uint8Array([8, 9]))
            : undefined;
          const changes = [replacement, renamed, parent, ...(file ? [file] : [])];
          const changed = reverse ? changes.toReversed() : changes;
          const result = await commit(
            fixture,
            before,
            `directory-cross-depth-after-${populated}-${reverse}`,
            changed,
          );

          await fixture.workspace.apply({
            before,
            after: result,
            changedInodes: changed,
            hydration: fixture.ports.hydration,
            signal: signal(),
          });

          expect(fixture.filesystem.lstat("/deep/moved").ino).toBe(directory);
          expect(fixture.filesystem.lstat("/old").ino).not.toBe(directory);
          if (child !== undefined) {
            expect(fixture.filesystem.lstat("/deep/moved/file").ino).toBe(child);
            const bytes = new Uint8Array(2);
            fixture.persistence.storage.readInto(child, 0n, bytes);
            expect(bytes).toEqual(new Uint8Array([8, 9]));
          }
          expect(fixture.ports.inspectTree(result)?.["/old"]?.stat.type).toBe("directory");
        } finally {
          fixture.close();
        }
      }
    }
  });
});
