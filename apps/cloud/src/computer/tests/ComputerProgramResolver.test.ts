import { describe, expect, it, vi } from "vite-plus/test";
import { ComputerProgramResolver } from "../ComputerProgramResolver.ts";
import type { MachineProgramInventory } from "../MachineProgramInventory.ts";
import { snapshotMachinePrograms } from "../MachineProgramInventory.ts";
import { childBashFixture } from "./ChildBashFixture.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { sqliteFixture } from "./helpers/sqliteFixture.ts";
import type { PosixStorage } from "../../kernel/PosixStorage.ts";

const file = (path: string) => ({ path, uid: 0, gid: 0, mode: 0o755 });
const inventory = (
  entries: MachineProgramInventory["entries"],
  image = "controlled-image",
): MachineProgramInventory => ({ image, entries, path: ["/usr/bin", "/bin"] });

describe("Computer program inventory lifecycle", () => {
  it("refreshes only unchanged owned entries across image changes", async () => {
    const fixture = childBashFixture();
    try {
      fixture.filesystem.mkdir("/usr");
      fixture.filesystem.mkdir("/usr/bin");
      fixture.write("/usr/bin/user-program", "user bytes", 0o755);
      const first = inventory([
        file("/usr/bin/removed"),
        file("/usr/bin/edited"),
        file("/usr/bin/user-program"),
        file("/usr/bin/target-a"),
        file("/usr/bin/target-b"),
        { ...file("/usr/bin/alias"), mode: 0o777, target: "/usr/bin/target-a" },
      ]);
      void new ComputerProgramResolver(fixture.filesystem, first);
      fixture.write("/usr/bin/edited", "edited by user", 0o755);
      const next = inventory(
        [
          { ...file("/usr/bin/target-a"), mode: 0o711 },
          file("/usr/bin/target-b"),
          { ...file("/usr/bin/alias"), mode: 0o777, target: "/usr/bin/target-b" },
        ],
        "controlled-image-v2",
      );
      void new ComputerProgramResolver(fixture.filesystem, next);
      expect(() => fixture.filesystem.lstat("/usr/bin/removed")).toThrow();
      expect(fixture.read("/usr/bin/edited")).toBe("edited by user");
      expect(fixture.read("/usr/bin/user-program")).toBe("user bytes");
      expect(fixture.filesystem.readlink("/usr/bin/alias")).toBe("/usr/bin/target-b");
      expect(fixture.filesystem.getPosixMetadata("/usr/bin/target-a").mode).toBe(0o711);
      const generation = fixture.filesystem.changeGeneration();
      void new ComputerProgramResolver(fixture.filesystem, next);
      expect(fixture.filesystem.changeGeneration()).toBe(generation);
    } finally {
      await fixture.close();
    }
  });

  it("does not mutate a read-only mount during startup", () => {
    const database = sqliteFixture();
    const storage = createFacetSqliteStorage(database.storage, () => 1n);
    storage.posix.initialize(storage.root, { mode: 0o755, uid: 1000, gid: 1000 });
    const filesystem = new KernelFileSystem({
      mounts: [{ path: "/", storage, readOnly: true }],
      posix: { credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 }, umask: 0o022 },
    });
    try {
      expect(
        () => new ComputerProgramResolver(filesystem, inventory([file("/usr/bin/program")])),
      ).toThrow("read-only");
      expect(filesystem.readdir("/")).toEqual([]);
    } finally {
      filesystem.dispose();
      database.close();
    }
  });

  it("reconciles an interrupted seed on the next open", async () => {
    const fixture = childBashFixture();
    const posix = (fixture.filesystem.resolve("/").mount.storage as PosixStorage).posix;
    const create = posix.create;
    const failure = vi.spyOn(posix, "create").mockImplementation((parent, name, options) => {
      if (name === "second") throw new Error("Interrupted image seed");
      return create(parent, name, options);
    });
    try {
      expect(
        () =>
          new ComputerProgramResolver(
            fixture.filesystem,
            inventory([file("/usr/bin/first"), file("/usr/bin/second")]),
          ),
      ).toThrow("Interrupted image seed");
      expect(fixture.filesystem.stat("/usr/bin/first").type).toBe("file");
      failure.mockRestore();
      void new ComputerProgramResolver(fixture.filesystem, inventory([], "next-image"));
      expect(fixture.filesystem.readdir("/usr/bin")).toEqual([]);
    } finally {
      failure.mockRestore();
      await fixture.close();
    }
  });

  it.each([
    { entries: [{ ...file("/usr/bin/program"), mode: 0o644 }] },
    { entries: [file("/usr/bin/program"), file("/usr/bin/program")] },
    { entries: [{ ...file("/usr/bin/alias"), target: "/missing-target" }] },
    { entries: [file("/usr/bin/../program")] },
  ])("rejects invalid inventory entries", ({ entries }) => {
    expect(() => snapshotMachinePrograms(inventory(entries))).toThrow();
  });
});
