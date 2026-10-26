import { describe, expect, it, vi } from "vite-plus/test";
import { loadCodexLocalePrograms } from "./CodexLocaleProductComputerFixture.ts";
import { gitRepositoryFixture, runGit } from "./GitRepositoryReadinessFixture.ts";
import { prepareHydratedRepository } from "../ComputerRepositoryReadiness.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const programs = loadCodexLocalePrograms();

describe.skipIf(programs === undefined)("hydrated Git repository readiness", () => {
  it("avoids tracked-content reads in the first and repeated read-only status", async () => {
    if (programs === undefined) throw new Error("Pinned Git programs are unavailable");
    const fixture = gitRepositoryFixture(programs);
    try {
      expect((await runGit(fixture, ["init", "--initial-branch=main"])).exitCode).toBe(0);
      fixture.fs.writeFileSync("/workspace/clean.txt", "clean\n");
      fixture.track("proof.txt");
      fixture.track("clean.txt");
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
      fixture.zeroIndexStats();
      fixture.advanceClock();
      expect(
        await prepareHydratedRepository({
          files: fixture.filesystem,
          commands: fixture.computer,
          signal: new AbortController().signal,
        }),
      ).toEqual({ status: "ready" });
      fixture.clearReads();
      const first = await runGit(fixture, [
        "--no-optional-locks",
        "status",
        "--short",
        "--ignore-submodules=dirty",
      ]);
      const firstReads = [...fixture.reads];
      fixture.clearReads();
      const repeated = await runGit(fixture, [
        "--no-optional-locks",
        "status",
        "--short",
        "--ignore-submodules=dirty",
      ]);
      const repeatedReads = [...fixture.reads];
      expect({ first, repeated, firstReads, repeatedReads }).toEqual({
        first: { stdout: "", stderr: "", exitCode: 0, signal: 0, coreDumped: false },
        repeated: { stdout: "", stderr: "", exitCode: 0, signal: 0, coreDumped: false },
        firstReads: [],
        repeatedReads: [],
      });
    } finally {
      await fixture.close();
    }
  });

  it("discovers a linked worktree from a nested cwd and skips ordinary folders", async () => {
    if (programs === undefined) throw new Error("Pinned Git programs are unavailable");
    const fixture = gitRepositoryFixture(programs);
    try {
      const input = {
        files: fixture.filesystem,
        commands: fixture.computer,
        signal: new AbortController().signal,
      };
      expect(await prepareHydratedRepository(input)).toEqual({ status: "not-a-repository" });
      expect(fixture.loaderCommands).toHaveLength(0);
      expect((await runGit(fixture, ["init", "--initial-branch=main"])).exitCode).toBe(0);
      expect((await runGit(fixture, ["add", "proof.txt"])).exitCode).toBe(0);
      fixture.fs.renameSync("/workspace/.git", "/metadata");
      fixture.fs.writeFileSync("/workspace/.git", "gitdir: /metadata\n");
      fixture.fs.mkdirSync("/workspace/nested");
      fixture.filesystem.chdir("/workspace/nested");
      fixture.advanceClock();
      expect(await prepareHydratedRepository(input)).toEqual({ status: "ready" });
      expect(fixture.loaderCommands.at(-1)?.cwd).toBe("/workspace/nested");
    } finally {
      await fixture.close();
    }
  });

  it("refuses a locked or corrupt index without overwriting it", async () => {
    if (programs === undefined) throw new Error("Pinned Git programs are unavailable");
    const fixture = gitRepositoryFixture(programs);
    try {
      const input = {
        files: fixture.filesystem,
        commands: fixture.computer,
        signal: new AbortController().signal,
      };
      expect((await runGit(fixture, ["init", "--initial-branch=main"])).exitCode).toBe(0);
      expect((await runGit(fixture, ["add", "proof.txt"])).exitCode).toBe(0);
      fixture.zeroIndexStats();
      const original = fixture.readFile("/workspace/.git/index");
      fixture.fs.writeFileSync("/workspace/.git/index.lock", "other writer");
      await expect(prepareHydratedRepository(input)).rejects.toThrow("index refresh failed");
      expect(fixture.readFile("/workspace/.git/index")).toEqual(original);
      expect(new TextDecoder().decode(fixture.readFile("/workspace/.git/index.lock"))).toBe(
        "other writer",
      );
      fixture.fs.unlinkSync("/workspace/.git/index.lock");
      fixture.fs.writeFileSync("/workspace/.git/index", "invalid index");
      await expect(prepareHydratedRepository(input)).rejects.toThrow("index refresh failed");
      expect(new TextDecoder().decode(fixture.readFile("/workspace/.git/index"))).toBe(
        "invalid index",
      );
    } finally {
      await fixture.close();
    }
  });

  it("cancels and joins the refresh before a later command can run", async () => {
    if (programs === undefined) throw new Error("Pinned Git programs are unavailable");
    const controller = new AbortController();
    let cancelling = false;
    const fixture = gitRepositoryFixture(programs, {
      beforeTrackedRead() {
        if (cancelling) controller.abort(new Error("Cancel during Git's content read"));
      },
    });
    try {
      expect((await runGit(fixture, ["init", "--initial-branch=main"])).exitCode).toBe(0);
      expect((await runGit(fixture, ["add", "proof.txt"])).exitCode).toBe(0);
      fixture.track("proof.txt");
      fixture.zeroIndexStats();
      cancelling = true;
      await expect(
        prepareHydratedRepository({
          files: fixture.filesystem,
          commands: fixture.computer,
          signal: controller.signal,
        }),
      ).rejects.toThrow();
      cancelling = false;
      expect((await runGit(fixture, ["status", "--short"])).exitCode).toBe(0);
      expect(() => fixture.filesystem.lstat("/workspace/.git/index.lock")).toThrow();
    } finally {
      await fixture.close();
    }
  });
});
