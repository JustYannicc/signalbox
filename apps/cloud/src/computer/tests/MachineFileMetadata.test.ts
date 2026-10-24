import { expect, it } from "vite-plus/test";
import { machineFileMetadata } from "../MachineFileMetadata.ts";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { sqliteFixture } from "./helpers/sqliteFixture.ts";

const stat = {
  type: "file" as const,
  mode: 0o755,
  uid: 1000,
  gid: 1000,
  size: "4",
  nlink: "2",
  atimeNs: "1234567890123456789",
  mtimeNs: "1234567890123456788",
  ctimeNs: "1234567890123456787",
};

it.each([
  {},
  { dev: "7" },
  { ino: "29" },
  { dev: "0", ino: "0" },
  { dev: "7", ino: "0" },
  { dev: "0", ino: "29" },
])(
  "keeps separate virtual file identities when the native pair is incomplete or zero: %j",
  async (identity) => {
    const database = sqliteFixture();
    const storage = createFacetSqliteStorage(database.storage, () => 1n);
    storage.posix.initialize(storage.root, { uid: 0, gid: 0, mode: 0o755 });
    const filesystem = new KernelFileSystem({
      mounts: [{ path: "/", storage }],
      posix: { credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 }, umask: 0o022 },
    });
    const entries = [
      machineFileMetadata("/machine", { ...stat, type: "directory" }),
      machineFileMetadata("/machine/a", { ...stat, ...identity }),
      machineFileMetadata("/machine/b", { ...stat, ...identity }),
    ];
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    const lower = filesystem.installLowerFileSystem({
      lookup: (paths) => paths.map((path) => byPath.get(path)),
      async readdir() {
        return entries.filter((entry) => entry.path !== "/machine");
      },
      async readlink() {
        throw new Error("Unexpected link read");
      },
      async read() {
        throw new Error("Unexpected file read");
      },
    });
    try {
      await lower.prepare(["/machine/a", "/machine/b"]);
      const a = filesystem.stat("/machine/a");
      const b = filesystem.stat("/machine/b");
      expect(a.ino).not.toBe(b.ino);
      expect(filesystem.stat("/machine/a").ino).toBe(a.ino);
      for (const entry of [a, b]) {
        expect(entry.nativeIno).toBeUndefined();
        expect(entry.nativeDev).toBeUndefined();
        expect(entry).toMatchObject({ type: "file", size: 4n, mtimeNs: 1234567890123456788n });
      }
      await expect(filesystem.checkExecutable("/machine/a")).resolves.toMatchObject({
        type: "file",
      });
    } finally {
      lower.dispose();
      filesystem.dispose();
      database.close();
    }
  },
);

it("preserves an exact nonzero native identity pair and nanosecond metadata", () => {
  const entry = machineFileMetadata("/machine/a", { ...stat, dev: "7", ino: "29" });
  expect(entry).toMatchObject({ nativeDev: 7n, nativeIno: 29n });
  expect(entry.stat.mtimeNs).toBe(1234567890123456788n);
});
