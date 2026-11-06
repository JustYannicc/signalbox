import { describe, expect, it } from "vite-plus/test";
import { createComputerMachineProfile } from "../computer/ComputerMachineProfile.ts";
import { machineInventoryFixture } from "../computer/machineInventoryTesting.ts";
import { validateMachineProgramInventory } from "../computer/MachineProgramInventory.ts";
import { createBootState } from "./KernelHarnessBoot.ts";
import { createHostStorage } from "./KernelHarnessStorage.ts";
import { KernelOpenFlags } from "./KernelFileSystem.ts";
import { createMemoryFilePersistencePorts } from "./MemoryFilePersistencePorts.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import {
  ensureDirectory,
  fingerprint,
  type SeedCatalog,
  writeSeedFiles,
} from "./KernelSeedCatalog.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const signal = new AbortController().signal;
const bytes = new TextEncoder().encode("verified executable");
const metadata = { mode: 0o755, uid: 1000, gid: 1000 };
const paths = ["/bin/find", "/usr/bin/find"];

async function fixture(lower: boolean, nativeLink = false) {
  const database = sqliteFixture();
  const wakes = new KernelWakeRegistry();
  const storage = createHostStorage(
    {
      identity: "seed-files",
      database: database.storage,
      nowNs: () => 1n,
      wakes,
      persistencePorts: createMemoryFilePersistencePorts(),
      rootMetadata: { ...metadata, mode: 0o755 },
      posix: { credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 }, umask: 0o022 },
      assetMode: 0o644,
      cwd: "/workspace",
    },
    "seed-thread",
  );
  let profile: ReturnType<typeof createComputerMachineProfile> | undefined;
  if (lower) {
    const inventory = machineInventoryFixture(
      [...paths, ...(nativeLink ? ["/usr/bin/native-find"] : [])].map((path) => ({
        path,
        mode: 0o755,
        uid: 0,
        gid: 0,
      })),
    );
    profile = createComputerMachineProfile({
      filesystem: storage.files,
      threadId: "seed-thread",
      machineInventory: validateMachineProgramInventory({
        ...inventory,
        entries: inventory.entries
          .filter((entry) => entry.path !== "/bin/find")
          .map((entry) =>
            entry.path === "/bin"
              ? { ...entry, type: "symlink", target: "usr/bin" }
              : nativeLink && entry.path === "/usr/bin/find"
                ? { ...entry, type: "symlink", target: "native-find" }
                : entry,
          ),
      }),
      transport: {
        files: {
          current: () => ({ generation: null, generationAbsent: true, pristine: false }),
          async markExecuted() {
            throw new Error("No machine execution allowed");
          },
          async lookup() {
            throw new Error("No machine lookup allowed");
          },
        },
        async spawn() {
          throw new Error("No process allowed");
        },
      },
      signal,
    });
  }
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const entries = paths.map((path) => ({ path, ...metadata, bytes: bytes.length, sha256 }));
  let reads = 0;
  const catalog: SeedCatalog = {
    id: await fingerprint(entries),
    stages: { assets: [], programs: entries },
    async payloads(stage) {
      reads++;
      return new Map(stage === "programs" ? paths.map((path) => [path, bytes.slice()]) : []);
    },
  };
  return {
    storage,
    catalog,
    get reads() {
      return reads;
    },
    boot: () => createBootState(storage, catalog, "seed-thread"),
    rows: (table: string) => [...database.storage.sql.exec(`SELECT * FROM ${table}`)],
    close() {
      profile?.overlay.dispose();
      storage.dispose();
      wakes.dispose();
      database.close();
    },
  };
}

function readFile(files: ReturnType<typeof createHostStorage>["files"], path: string) {
  const fd = files.open(path, KernelOpenFlags.O_RDONLY);
  try {
    const result = new Uint8Array(Number(files.fstat(fd).size));
    expect(files.read(fd, result, null)).toBe(result.length);
    return result;
  } finally {
    files.close(fd);
  }
}

describe("Canonical seed directories and machine aliases", () => {
  it.each([false, true])(
    "seeds, reverifies and claims both executable aliases with lower=%s",
    async (lower) => {
      const f = await fixture(lower);
      try {
        const boot = f.boot();
        await boot.seed("assets", signal);
        await boot.seed("programs", signal);
        await boot.seed("programs", signal);
        const { files } = f.storage;
        expect(files.lstat("/bin").type).toBe(lower ? "symlink" : "directory");
        for (const path of paths) {
          expect(readFile(files, path)).toEqual(bytes);
          expect(files.stat(path).posix).toEqual(metadata);
        }
        expect(files.realpath("/bin/find")).toBe(lower ? "/usr/bin/find" : "/bin/find");
        await boot.claim("attempt-one", "input-hash", signal);
        const recovered = f.boot();
        await recovered.seed("assets", signal);
        await recovered.seed("programs", signal);
        await recovered.claim("attempt-two", "input-hash", signal);
        expect(f.rows("harness_seed_receipts")).toHaveLength(2);
        expect(f.rows("harness_boot_attempts")).toHaveLength(2);
        expect(f.reads).toBe(9);
      } finally {
        f.close();
      }
    },
  );

  it.each(["file", "escape"])("rejects a directory symlink to %s", async (target) => {
    const f = await fixture(false);
    try {
      const { files } = f.storage;
      const fd = files.open("/target", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY);
      files.close(fd);
      files.symlink(target === "file" ? "target" : "../outside", "/bin");
      expect(() => ensureDirectory(files, "/bin")).toThrow();
      await f.boot().seed("assets", signal);
      await expect(f.boot().seed("programs", signal)).rejects.toThrow();
      expect(f.rows("harness_seed_receipts")).toHaveLength(1);
      expect(f.rows("harness_boot_attempts")).toHaveLength(0);
    } finally {
      f.close();
    }
  });

  it.each(["bytes", "mode", "uid", "gid", "receipt"])(
    "rejects %s tampering before another alias claim",
    async (corruption) => {
      const f = await fixture(true);
      try {
        const boot = f.boot();
        await boot.seed("assets", signal);
        await boot.seed("programs", signal);
        const { files } = f.storage;
        if (corruption === "bytes") {
          const fd = files.open("/bin/find", KernelOpenFlags.O_WRONLY);
          try {
            files.write(fd, new Uint8Array([0]), null);
          } finally {
            files.close(fd);
          }
        } else if (corruption === "mode") files.chmod("/usr/bin/find", 0o700);
        else if (corruption === "receipt")
          f.storage.database.sql.exec("DELETE FROM harness_seed_receipts WHERE stage='programs'");
        else {
          const resolved = files.resolve("/usr/bin/find");
          f.storage.database.sql.exec(
            `UPDATE kernel_fs_posix SET ${corruption}=${corruption}+1 WHERE ino=?`,
            resolved.inode.toString(),
          );
        }
        await expect(f.boot().claim("tampered", "input-hash", signal)).rejects.toThrow();
        expect(f.rows("harness_boot_attempts")).toHaveLength(0);
      } finally {
        f.close();
      }
    },
  );

  it("shadows a native executable symlink while preserving its native target", async () => {
    const f = await fixture(true, true);
    try {
      const boot = f.boot();
      await boot.seed("assets", signal);
      await boot.seed("programs", signal);
      await boot.claim("native-link", "input-hash", signal);
      for (const path of paths) {
        expect(f.storage.files.lstat(path).type).toBe("file");
        expect(readFile(f.storage.files, path)).toEqual(bytes);
      }
      expect(f.storage.files.stat("/usr/bin/native-find").size).toBe(0n);
    } finally {
      f.close();
    }
  });

  it("refuses an unreceipted upper symlink", async () => {
    const f = await fixture(false);
    try {
      const { files } = f.storage;
      ensureDirectory(files, "/usr/bin");
      files.symlink("find", "/usr/bin/alias");
      const entry = { ...f.catalog.stages.programs[0]!, path: "/usr/bin/alias" };
      expect(() => writeSeedFiles(files, [entry], new Map([[entry.path, bytes]]))).toThrow();
      expect(files.lstat(entry.path).type).toBe("symlink");
    } finally {
      f.close();
    }
  });

  it("rejects conflicting alias descriptors without issuing a program receipt", async () => {
    const f = await fixture(true);
    try {
      const entries = f.catalog.stages.programs.map((entry, index) =>
        index === 0 ? entry : { ...entry, mode: 0o700 },
      );
      const boot = createBootState(
        f.storage,
        { ...f.catalog, stages: { assets: [], programs: entries } },
        "seed-thread",
      );
      await boot.seed("assets", signal);
      await expect(boot.seed("programs", signal)).rejects.toThrow();
      expect(f.rows("harness_seed_receipts")).toHaveLength(1);
    } finally {
      f.close();
    }
  });

  it("refuses an unreceipted upper file even when its bytes match", async () => {
    const f = await fixture(true);
    try {
      const { files } = f.storage;
      ensureDirectory(files, "/usr/bin");
      const fd = files.open(
        "/usr/bin/unclaimed",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_EXCL | KernelOpenFlags.O_WRONLY,
        metadata.mode,
      );
      try {
        files.write(fd, bytes, null);
      } finally {
        files.close(fd);
      }
      const entry = { ...f.catalog.stages.programs[0]!, path: "/usr/bin/unclaimed" };
      expect(() => writeSeedFiles(files, [entry], new Map([[entry.path, bytes]]))).toThrow();
      expect(readFile(files, entry.path)).toEqual(bytes);
    } finally {
      f.close();
    }
  });
});
