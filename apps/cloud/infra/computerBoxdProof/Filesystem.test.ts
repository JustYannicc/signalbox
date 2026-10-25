import { expect, it } from "vite-plus/test";
import { KernelOpenFlags } from "../../src/kernel/KernelFileSystem.ts";
import { openProofFilesystem } from "./Filesystem.ts";
import { sqliteFixture } from "./ProofSqliteFixture.ts";

it("initializes a new proof root and preserves recorded metadata and bytes on reopen", () => {
  const database = sqliteFixture();
  const first = openProofFilesystem(database.storage);
  try {
    expect(first.filesystem.getPosixMetadata("/")).toEqual({ mode: 0o755, uid: 0, gid: 0 });
    first.filesystem.chmod("/", 0o710);
    first.filesystem.chown("/", 47, 53);
    first.write("/saved", new Uint8Array([0, 17, 255]), 0o640);
  } finally {
    first.close();
  }
  const reopened = openProofFilesystem(database.storage);
  try {
    expect(reopened.filesystem.getPosixMetadata("/")).toEqual({ mode: 0o710, uid: 47, gid: 53 });
    const fd = reopened.filesystem.open("/saved", KernelOpenFlags.O_RDONLY);
    try {
      expect(reopened.read(fd)).toEqual(new Uint8Array([0, 17, 255]));
    } finally {
      reopened.filesystem.close(fd);
    }
    expect(reopened.filesystem.getPosixMetadata("/saved").mode).toBe(0o640);
  } finally {
    reopened.close();
    database.close();
  }
});
