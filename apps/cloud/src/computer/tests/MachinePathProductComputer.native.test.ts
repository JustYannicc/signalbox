import { describe, expect, it, vi } from "vite-plus/test";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import { emptyMachineFilesFixture } from "../machineInventoryTesting.ts";
import { controlledMachineFiles } from "./MachinePathControlledFiles.ts";
import { bashModule, machinePathFixture, machinePathInventory } from "./MachinePathFixture.ts";
import { writeUpperFile } from "./MachinePathFixtureSupport.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe.skipIf(bashModule === undefined)("ProductComputer machine PATH discovery", () => {
  it.each(["jq", "sort", "uniq -c", "wc", "awk", "xargs", "find"])(
    "admits bare %s to the machine with exact argv",
    async (command) => {
      const fixture = machinePathFixture(bashModule!);
      try {
        const result = await fixture.run(command);
        expect(result.status.exitCode).toBe(23);
        expect(result.stderr).toBe("");
        expect(
          fixture.machineCalls.map((call) => ({ executable: call.executable, argv: call.argv })),
        ).toEqual([{ executable: `/bin/${command.split(" ")[0]}`, argv: command.split(" ") }]);
      } finally {
        await fixture.close();
      }
    },
  );

  it("admits both stages of the machine pipeline", async () => {
    const fixture = machinePathFixture(bashModule!);
    try {
      const result = await fixture.run('printf "b\\na\\nb\\n" | sort | uniq -c');
      expect(result.status.exitCode, JSON.stringify({ result, calls: fixture.machineCalls })).toBe(
        23,
      );
      expect(result.stderr).toBe("");
      expect(
        fixture.machineCalls
          .map((call) => ({ executable: call.executable, argv: call.argv }))
          .sort((a, b) => a.executable.localeCompare(b.executable)),
      ).toEqual([
        { executable: "/bin/sort", argv: ["sort"] },
        { executable: "/bin/uniq", argv: ["uniq", "-c"] },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("keeps the dirty transition across ProductComputer reopen", async () => {
    const machineFiles = controlledMachineFiles(machinePathInventory);
    const first = machinePathFixture(bashModule!, { files: machineFiles.files });
    try {
      expect((await first.run("sort")).status.exitCode).toBe(23);
      expect(machineFiles.state()).toEqual({ generation: 1, pristine: false });
    } finally {
      await first.close();
    }

    const reopened = machinePathFixture(bashModule!, { files: machineFiles.files });
    try {
      expect((await reopened.run("uniq -c")).status.exitCode).toBe(23);
      expect(machineFiles.calls.length).toBeGreaterThan(0);
      expect(machineFiles.state()).toEqual({ generation: 1, pristine: false });
    } finally {
      await reopened.close();
    }
  });

  it("agrees across command -v, type, hash, PATH order and exec", async () => {
    const fixture = machinePathFixture(bashModule!);
    try {
      const result = await fixture.run(
        "command -v sort; type -p sort; hash sort; hash -t sort; sort",
        "/usr/bin:/bin",
      );
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("/usr/bin/sort\n/usr/bin/sort\n/usr/bin/sort\n");
      expect(result.status.exitCode).toBe(23);
      expect(fixture.machineCalls.map((call) => call.executable)).toEqual(["/usr/bin/sort"]);
    } finally {
      await fixture.close();
    }
  });

  it("keeps a nonexistent command at 127 without machine admission", async () => {
    const fixture = machinePathFixture(bashModule!);
    try {
      const result = await fixture.run("signalbox_nonexistent_r29");
      expect(result.status.exitCode).toBe(127);
      expect(result.stderr).toContain("command not found");
      expect(fixture.machineCalls).toEqual([]);
      expect(fixture.fileLookups).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("keeps a fresh thread typo on its image and does not start a machine process", async () => {
    const files = emptyMachineFilesFixture();
    const fixture = machinePathFixture(bashModule!, {
      threadId: "machine-path-fresh-thread-typo",
      files,
    });
    try {
      const result = await fixture.run("signalbox_fresh_thread_typo");
      expect(result.status.exitCode).toBe(127);
      expect(result.stderr).toContain("command not found");
      expect(fixture.machineCalls).toEqual([]);
      expect(files.current()).toMatchObject({ generation: 1, pristine: true });
    } finally {
      await fixture.close();
    }
  });

  it("uses the same resolver for direct exec and preserves argv[0]", async () => {
    const fixture = machinePathFixture(bashModule!);
    try {
      expect(
        (await fixture.direct("sort", ["custom-argv0", "-n"], "/usr/bin:/bin")).status.exitCode,
      ).toBe(23);
      expect(
        fixture.machineCalls.map((call) => ({ executable: call.executable, argv: call.argv })),
      ).toEqual([{ executable: "/usr/bin/sort", argv: ["custom-argv0", "-n"] }]);
      await expect(fixture.direct("signalbox_nonexistent_r29", ["custom-argv0"])).rejects.toThrow(
        "not found",
      );
      expect(fixture.machineCalls).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("keeps catalog programs local at their machine PATH aliases", async () => {
    const fixture = machinePathFixture(bashModule!);
    try {
      const result = await fixture.run(
        "command -v bash; type -p bash; hash bash; hash -t bash; bash --noprofile --norc -c 'printf LOCAL'",
        "/usr/bin:/bin",
      );
      expect(result.status.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("/usr/bin/bash\n/usr/bin/bash\n/usr/bin/bash\nLOCAL");
      expect(fixture.localCalls).toEqual(["/bin/bash", "/bin/bash"]);
      expect(fixture.machineCalls).toEqual([]);
      expect((await fixture.run("command -v git", "/usr/bin:/bin")).stdout).toBe("/usr/bin/git\n");
    } finally {
      await fixture.close();
    }
  });

  it("uses machine file mode for Bash executable predicates without copying file bytes", async () => {
    const fixture = machinePathFixture(bashModule!);
    try {
      const result = await fixture.run(
        '[ -f /usr/bin/sort ]; printf "file=%s\\n" "$?"; [ -x /usr/bin/sort ]; printf "x=%s\\n" "$?"; [ -L /usr/bin/sort ]; printf "L=%s\\n" "$?"',
        "/usr/bin:/bin",
      );
      expect(result.status.exitCode).toBe(0);
      expect(result.stdout).toBe("file=0\nx=0\nL=1\n");
      expect(result.stderr).toBe("");
      expect(fixture.machineCalls).toEqual([]);
      expect(fixture.fileLookups).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("continues past a non-executable PATH match for both direct exec and Bash", async () => {
    const fixture = machinePathFixture(bashModule!);
    try {
      fixture.filesystem.mkdir("/workspace/early");
      const fd = fixture.filesystem.open(
        "/workspace/early/sort",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY,
        0o644,
      );
      fixture.filesystem.close(fd);
      expect(
        (await fixture.direct("sort", ["sort", "-n"], "/workspace/early:/usr/bin")).status.exitCode,
      ).toBe(23);
      expect((await fixture.run("sort -n", "/workspace/early:/usr/bin")).status.exitCode).toBe(23);
      await expect(fixture.direct("sort", ["sort"], "/workspace/early")).rejects.toThrow(
        "not executable",
      );
      expect((await fixture.run("sort", "/workspace/early")).status.exitCode).toBe(126);
      expect(
        fixture.machineCalls.map((call) => ({ executable: call.executable, argv: call.argv })),
      ).toEqual([
        { executable: "/usr/bin/sort", argv: ["sort", "-n"] },
        { executable: "/usr/bin/sort", argv: ["sort", "-n"] },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("forwards an explicit machine-only path", async () => {
    const fixture = machinePathFixture(bashModule!);
    try {
      expect(
        (await fixture.direct("/usr/lib/git-core/git-remote-https", ["git-remote-https"])).status
          .exitCode,
      ).toBe(23);
      expect(
        fixture.machineCalls.map((call) => ({ executable: call.executable, argv: call.argv })),
      ).toEqual([
        {
          executable: "/usr/lib/git-core/git-remote-https",
          argv: ["git-remote-https"],
        },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("executes a user script at /usr/bin/bash instead of the catalog alias", async () => {
    const fixture = machinePathFixture(bashModule!, {
      before(filesystem) {
        writeUpperFile(filesystem, "/usr/bin/bash", "printf USER_BASH_ALIAS\n");
      },
    });
    try {
      const result = await fixture.run("/usr/bin/bash --noprofile --norc -c 'printf CATALOG'");
      expect(result.status.exitCode).toBe(0);
      expect(result.stdout).toBe("USER_BASH_ALIAS");
      expect(result.stderr).toBe("");
      expect(fixture.localCalls).toEqual(["/bin/bash"]);
      expect(fixture.machineCalls).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
