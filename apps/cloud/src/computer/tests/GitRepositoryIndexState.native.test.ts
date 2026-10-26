import { describe, expect, it, vi } from "vite-plus/test";
import { loadCodexLocalePrograms } from "./CodexLocaleProductComputerFixture.ts";
import { gitRepositoryFixture, runGit } from "./GitRepositoryReadinessFixture.ts";
import { prepareHydratedRepository } from "../ComputerRepositoryReadiness.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const programs = loadCodexLocalePrograms();

describe.skipIf(programs === undefined)("hydrated Git index state", () => {
  it("preserves staged content, unstaged edits, modes, symlinks, deletions and gitlinks", async () => {
    if (programs === undefined) throw new Error("Pinned Git programs are unavailable");
    const fixture = gitRepositoryFixture(programs);
    try {
      expect((await runGit(fixture, ["init", "--initial-branch=main"])).exitCode).toBe(0);
      fixture.fs.writeFileSync("/workspace/mode.sh", "echo mode\n");
      fixture.fs.writeFileSync("/workspace/deleted.txt", "deleted\n");
      fixture.fs.symlinkSync("proof.txt", "/workspace/link");
      expect((await runGit(fixture, ["add", "."])).exitCode).toBe(0);
      expect(
        (
          await runGit(fixture, [
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-m",
            "Seed",
          ])
        ).exitCode,
      ).toBe(0);
      const head = (await runGit(fixture, ["rev-parse", "HEAD"])).stdout.trim();
      expect(
        (
          await runGit(fixture, [
            "update-index",
            "--add",
            "--cacheinfo",
            `160000,${head},submodule`,
          ])
        ).exitCode,
      ).toBe(0);
      fixture.fs.writeFileSync("/workspace/proof.txt", "staged\n");
      expect((await runGit(fixture, ["add", "proof.txt"])).exitCode).toBe(0);
      fixture.fs.writeFileSync("/workspace/proof.txt", "unstaged\n");
      fixture.fs.chmodSync("/workspace/mode.sh", 0o755);
      fixture.fs.unlinkSync("/workspace/link");
      fixture.fs.symlinkSync("mode.sh", "/workspace/link");
      fixture.fs.unlinkSync("/workspace/deleted.txt");
      fixture.zeroIndexStats();
      fixture.advanceClock();
      const before = await runGit(fixture, ["ls-files", "--stage", "-z"]);
      const beforeStatus = await runGit(fixture, [
        "--no-optional-locks",
        "status",
        "--short",
        "--ignore-submodules=dirty",
      ]);
      expect(beforeStatus.stdout).toBe(
        " D deleted.txt\n M link\n M mode.sh\nMM proof.txt\nAD submodule\n",
      );
      expect(
        await prepareHydratedRepository({
          files: fixture.filesystem,
          commands: fixture.computer,
          signal: new AbortController().signal,
        }),
      ).toEqual({ status: "needs-update" });
      expect(await runGit(fixture, ["ls-files", "--stage", "-z"])).toEqual(before);
      expect(
        await runGit(fixture, [
          "--no-optional-locks",
          "status",
          "--short",
          "--ignore-submodules=dirty",
        ]),
      ).toEqual(beforeStatus);
      expect(new TextDecoder().decode(fixture.readFile("/workspace/proof.txt"))).toBe("unstaged\n");
      expect(fixture.filesystem.getPosixMetadata("/workspace/mode.sh").mode).toBe(0o755);
      expect(fixture.fs.readlinkSync("/workspace/link")).toBe("mode.sh");
    } finally {
      await fixture.close();
    }
  });

  it("keeps Git's same-second change detection", async () => {
    if (programs === undefined) throw new Error("Pinned Git programs are unavailable");
    const fixture = gitRepositoryFixture(programs);
    try {
      expect((await runGit(fixture, ["init", "--initial-branch=main"])).exitCode).toBe(0);
      expect((await runGit(fixture, ["add", "proof.txt"])).exitCode).toBe(0);
      fixture.zeroIndexStats();
      expect(
        await prepareHydratedRepository({
          files: fixture.filesystem,
          commands: fixture.computer,
          signal: new AbortController().signal,
        }),
      ).toEqual({ status: "ready" });
      fixture.fs.writeFileSync("/workspace/proof.txt", "AFTERS\n");
      expect((await runGit(fixture, ["--no-optional-locks", "status", "--short"])).stdout).toBe(
        "AM proof.txt\n",
      );
    } finally {
      await fixture.close();
    }
  });

  it.each([3, 4])("preserves version %i and user index flags", async (version) => {
    if (programs === undefined) throw new Error("Pinned Git programs are unavailable");
    const fixture = gitRepositoryFixture(programs);
    try {
      expect((await runGit(fixture, ["init", "--initial-branch=main"])).exitCode).toBe(0);
      fixture.fs.writeFileSync("/workspace/assumed.txt", "assumed\n");
      fixture.fs.writeFileSync("/workspace/skipped.txt", "skipped\n");
      expect((await runGit(fixture, ["add", "."])).exitCode).toBe(0);
      expect(
        (await runGit(fixture, ["update-index", "--assume-unchanged", "assumed.txt"])).exitCode,
      ).toBe(0);
      expect(
        (await runGit(fixture, ["update-index", "--skip-worktree", "skipped.txt"])).exitCode,
      ).toBe(0);
      expect((await runGit(fixture, ["update-index", `--index-version=${version}`])).exitCode).toBe(
        0,
      );
      const before = await runGit(fixture, ["ls-files", "--stage", "-v", "-z"]);
      fixture.advanceClock();
      fixture.fs.writeFileSync("/workspace/proof.txt", "BEFORE\n");
      fixture.advanceClock();
      expect(
        await prepareHydratedRepository({
          files: fixture.filesystem,
          commands: fixture.computer,
          signal: new AbortController().signal,
        }),
      ).toEqual({ status: "ready" });
      expect(await runGit(fixture, ["ls-files", "--stage", "-v", "-z"])).toEqual(before);
      const index = fixture.readFile("/workspace/.git/index");
      expect(new DataView(index.buffer, index.byteOffset, index.byteLength).getUint32(4)).toBe(
        version,
      );
    } finally {
      await fixture.close();
    }
  });

  it("leaves unresolved merge stages intact", async () => {
    if (programs === undefined) throw new Error("Pinned Git programs are unavailable");
    const fixture = gitRepositoryFixture(programs);
    try {
      expect((await runGit(fixture, ["init", "--initial-branch=main"])).exitCode).toBe(0);
      expect((await runGit(fixture, ["add", "proof.txt"])).exitCode).toBe(0);
      const oid = (await runGit(fixture, ["rev-parse", ":proof.txt"])).stdout.trim();
      expect(
        (await runGit(fixture, ["update-index", "--force-remove", "proof.txt"])).exitCode,
      ).toBe(0);
      const input = fixture.computer.exec(
        {
          executable: "/usr/bin/git",
          argv: ["git", "update-index", "--index-info"],
          cwd: "/workspace",
          env: {},
        },
        new AbortController().signal,
        undefined,
      );
      const child = await input;
      try {
        const writer = child.stdin.getWriter();
        await writer.write(
          new TextEncoder().encode(
            `100644 ${oid} 1\tproof.txt\n100644 ${oid} 2\tproof.txt\n100644 ${oid} 3\tproof.txt\n`,
          ),
        );
        await writer.close();
        writer.releaseLock();
        const [, , exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(exit.exitCode).toBe(0);
      } finally {
        await child.dispose();
      }
      const before = await runGit(fixture, ["ls-files", "--stage", "-z"]);
      expect(
        await prepareHydratedRepository({
          files: fixture.filesystem,
          commands: fixture.computer,
          signal: new AbortController().signal,
        }),
      ).toEqual({ status: "needs-update" });
      expect(await runGit(fixture, ["ls-files", "--stage", "-z"])).toEqual(before);
      expect((await runGit(fixture, ["--no-optional-locks", "status", "--short"])).stdout).toBe(
        "UU proof.txt\n",
      );
    } finally {
      await fixture.close();
    }
  });
});
