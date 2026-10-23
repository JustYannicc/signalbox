import { describe, expect, it, vi } from "vite-plus/test";
import { bashModule, machinePathFixture } from "./MachinePathFixture.ts";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";

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

  it("admits both stages of the R29 pipeline", async () => {
    const fixture = machinePathFixture(bashModule!);
    try {
      const result = await fixture.run('printf "b\\na\\nb\\n" | sort | uniq -c');
      expect(result.status.exitCode).toBe(23);
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

  it("exposes executable regular files, resolved symlinks, directory listings and readable stubs", async () => {
    const fixture = machinePathFixture(bashModule!);
    try {
      expect(fixture.filesystem.stat("/usr/bin/sort")).toMatchObject({
        type: "file",
        posix: { mode: 0o755, uid: 0, gid: 0 },
      });
      expect(fixture.filesystem.lstat("/usr/bin/awk").type).toBe("symlink");
      expect(fixture.filesystem.realpath("/usr/bin/awk")).toBe("/usr/bin/mawk");
      expect(fixture.filesystem.realpath("/bin/sort")).toBe("/usr/bin/sort");
      fixture.filesystem.access("/usr/bin/sort", 1, true);
      expect(fixture.filesystem.readdir("/usr/bin")).toEqual(
        expect.arrayContaining(["jq", "sort", "uniq", "wc", "awk", "xargs", "find", "git"]),
      );
      const fd = fixture.filesystem.open("/usr/bin/sort", KernelOpenFlags.O_RDONLY);
      try {
        const bytes = new Uint8Array(Number(fixture.filesystem.fstat(fd).size));
        fixture.filesystem.read(fd, bytes, 0n);
        expect(new TextDecoder().decode(bytes)).toContain("Signalbox machine executable entry");
      } finally {
        fixture.filesystem.close(fd);
      }
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

  it("still applies normal machine admission to an unqualified catalog alias", async () => {
    const fixture = machinePathFixture(bashModule!);
    try {
      expect((await fixture.run("/usr/bin/grep -P pattern")).status.exitCode).toBe(23);
      expect(
        fixture.machineCalls.map((call) => ({ executable: call.executable, argv: call.argv })),
      ).toEqual([{ executable: "/usr/bin/grep", argv: ["/usr/bin/grep", "-P", "pattern"] }]);
    } finally {
      await fixture.close();
    }
  });
});
