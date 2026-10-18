import { describe, expect, it } from "@effect/vitest";
import type { KernelAsyncProgramContext } from "../../kernel/KernelAsyncProgram.ts";
import { createNodeFs } from "../NodeFs.ts";
import { createNodeGitProgram, selectNodeGitRoute } from "../NodeGit.ts";
import {
  createLocalGitRunner,
  createNodeGitFixture,
  createSmartHttpServer,
  finishGit,
  spawnGit,
} from "./helpers/NodeGitFixture.ts";

describe("NodeGit HTTP routing", () => {
  it("routes explicitly and refuses flags the HTTP adapter cannot preserve", () => {
    expect(
      selectNodeGitRoute([
        "/usr/bin/git",
        "-C",
        "nested",
        "clone",
        "--depth=1",
        "--branch",
        "main",
        "https://git.invalid/repo.git",
      ]),
    ).toMatchObject({ kind: "clone", cwd: ["nested"], depth: 1, ref: "main", dir: "repo" });
    expect(selectNodeGitRoute(["/usr/bin/git", "status", "--porcelain"]).kind).toBe("local");
    expect(selectNodeGitRoute(["/usr/bin/git", "push", "origin", "main"])).toMatchObject({
      kind: "reject",
      exitCode: 129,
    });
    expect(
      selectNodeGitRoute([
        "/usr/bin/git",
        "clone",
        "--filter=blob:none",
        "https://git.invalid/repo",
      ]),
    ).toMatchObject({ kind: "reject", message: expect.stringContaining("--filter=blob:none") });
    expect(
      selectNodeGitRoute(["/usr/bin/git", "-c", "http.proxy=http://invalid", "push", "origin"]),
    ).toMatchObject({ kind: "reject", message: expect.stringContaining("-c") });
    expect(
      selectNodeGitRoute(["/usr/bin/git", "--config-env=http.proxy=GIT_PROXY", "fetch"]),
    ).toMatchObject({ kind: "reject", message: expect.stringContaining("--config-env") });
  });

  it("rejects the full Git config, HTTP, and SSH environment override families before effects", async () => {
    const fixture = createNodeGitFixture();
    const server = createSmartHttpServer({ authenticate: false });
    let localCalls = 0;
    try {
      const program = createNodeGitProgram({
        local: createLocalGitRunner(() => (localCalls += 1)),
        fetch: server.fetch,
      });
      for (const name of ["GIT_CONFIG_COUNT", "GIT_HTTP_USER_AGENT", "GIT_SSH_COMMAND"]) {
        const { host, handle } = await spawnGit(
          fixture.filesystem,
          program,
          ["/usr/bin/git", "clone", "https://git.invalid/remote.git", name],
          { [name]: "caller-value" },
        );
        const status = await finishGit(host, handle);
        expect(status.exitCode).toBe(129);
        expect(fixture.stderr()).toContain(name);
        expect(createNodeFs(fixture.filesystem).fs.existsSync(`/work/${name}`)).toBe(false);
      }
      const optionRun = await spawnGit(fixture.filesystem, program, [
        "/usr/bin/git",
        "-c",
        "http.proxy=http://invalid",
        "clone",
        "https://git.invalid/remote.git",
        "global-option",
      ]);
      const optionStatus = await finishGit(optionRun.host, optionRun.handle);
      expect(optionStatus.exitCode).toBe(129);
      expect(fixture.stderr()).toContain("global option is not supported");
      expect(createNodeFs(fixture.filesystem).fs.existsSync("/work/global-option")).toBe(false);
      expect(server.requests).toEqual([]);
      expect(localCalls).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it("preserves argv, cwd, and env for local Git commands", async () => {
    const fixture = createNodeGitFixture();
    let seen:
      | { args: readonly string[]; cwd: string; env: Readonly<Record<string, string>> }
      | undefined;
    try {
      const program = createNodeGitProgram({
        local: {
          run: async (context: KernelAsyncProgramContext) => {
            seen = { args: context.args, cwd: context.filesystem.cwd, env: context.env };
            return { exitCode: 42, signal: 0, coreDumped: false };
          },
        },
      });
      const env = { GIT_AUTHOR_NAME: "Caller", CUSTOM: "value" };
      const { host, handle } = await spawnGit(
        fixture.filesystem,
        program,
        ["/usr/bin/git", "-C", "nested", "status", "--porcelain"],
        env,
      );
      const status = await finishGit(host, handle);

      expect(status.exitCode).toBe(42);
      expect(seen).toEqual({
        args: ["/usr/bin/git", "-C", "nested", "status", "--porcelain"],
        cwd: "/work",
        env: { ...env, HOME: "/home/test" },
      });
    } finally {
      fixture.close();
    }
  });
});
