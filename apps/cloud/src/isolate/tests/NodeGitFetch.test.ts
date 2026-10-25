import { describe, expect, it } from "@effect/vitest";
import git from "isomorphic-git";
import { createNodeFs } from "../NodeFs.ts";
import { createNodeGitProgram } from "../NodeGit.ts";
import {
  createLocalGitRunner,
  createNodeGitFixture,
  createSmartHttpServer,
  finishGit,
  GIT_FIXTURE_COMMIT,
  malformedGitPack,
  spawnGit,
} from "./helpers/NodeGitFixture.ts";

describe("NodeGit HTTP fetch", () => {
  it("resolves bare fetch through the current branch remote and repository root", async () => {
    const fixture = createNodeGitFixture();
    const server = createSmartHttpServer({ authenticate: false });
    const nodeFs = createNodeFs(fixture.filesystem).fs;
    await initializeFetchRepo(nodeFs, {
      originUrl: "https://user:secret@git.invalid/decoy.git",
      upstreamUrl: "https://git.invalid/upstream.git",
      branchRemote: "upstream",
    });
    try {
      const program = createNodeGitProgram({
        local: createLocalGitRunner(),
        fetch: server.fetch,
      });
      const { host, handle } = await spawnGit(fixture.filesystem, program, [
        "/usr/bin/git",
        "-C",
        "repo/subdir",
        "fetch",
      ]);
      const status = await finishGit(host, handle);

      expect(status.exitCode, fixture.stderr()).toBe(0);
      expect(server.requests.some(({ url }) => url.includes("/upstream.git/"))).toBe(true);
      expect(server.requests.some(({ url }) => url.includes("/decoy.git/"))).toBe(false);
      expect(
        await git.resolveRef({ fs: nodeFs, dir: "/work/repo", ref: "refs/remotes/upstream/main" }),
      ).toBe(GIT_FIXTURE_COMMIT);
    } finally {
      fixture.close();
    }
  });

  it("validates configured remote URLs and rejects configured CORS proxies before transport", async () => {
    const fixture = createNodeGitFixture();
    const server = createSmartHttpServer({ authenticate: false });
    const nodeFs = createNodeFs(fixture.filesystem).fs;
    await initializeFetchRepo(nodeFs, {
      upstreamUrl: "https://user:secret@git.invalid/upstream.git",
      branchRemote: "upstream",
    });
    try {
      const program = createNodeGitProgram({ local: createLocalGitRunner(), fetch: server.fetch });
      const { host, handle } = await spawnGit(fixture.filesystem, program, [
        "/usr/bin/git",
        "-C",
        "repo",
        "fetch",
        "upstream",
      ]);
      const status = await finishGit(host, handle);
      expect(status.exitCode).toBe(129);
      expect(fixture.stderr()).toContain(
        "supply Git credentials through the caller's auth callback",
      );
      expect(server.requests).toEqual([]);

      await git.setConfig({
        fs: nodeFs,
        dir: "/work/repo",
        path: "remote.upstream.url",
        value: "https://git.invalid/upstream.git",
      });
      await git.setConfig({
        fs: nodeFs,
        dir: "/work/repo",
        path: "http.corsProxy",
        value: "https://proxy.invalid",
      });
      const proxyRun = await spawnGit(fixture.filesystem, program, [
        "/usr/bin/git",
        "-C",
        "repo",
        "fetch",
        "upstream",
      ]);
      const proxyStatus = await finishGit(proxyRun.host, proxyRun.handle);
      expect(proxyStatus.exitCode).toBe(129);
      expect(fixture.stderr()).toContain("http.corsProxy");
      expect(server.requests).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it("does not publish remote refs or pack indexes when pack indexing fails", async () => {
    const fixture = createNodeGitFixture();
    const nodeFs = createNodeFs(fixture.filesystem).fs;
    const nextCommit = "1111111111111111111111111111111111111111";
    await initializeFetchRepo(nodeFs);
    await git.writeRef({
      fs: nodeFs,
      dir: "/work/repo",
      ref: "refs/remotes/upstream/main",
      value: GIT_FIXTURE_COMMIT,
    });
    const server = createSmartHttpServer({
      authenticate: false,
      commit: nextCommit,
      pack: malformedGitPack(),
    });
    try {
      const program = createNodeGitProgram({ local: createLocalGitRunner(), fetch: server.fetch });
      const { host, handle } = await spawnGit(fixture.filesystem, program, [
        "/usr/bin/git",
        "-C",
        "repo",
        "fetch",
        "upstream",
      ]);
      const status = await finishGit(host, handle);

      expect(status.exitCode).toBe(128);
      expect(
        await git.resolveRef({ fs: nodeFs, dir: "/work/repo", ref: "refs/remotes/upstream/main" }),
      ).toBe(GIT_FIXTURE_COMMIT);
      expect(await nodeFs.promises.readdir("/work/repo/.git/objects/pack")).toEqual([]);
      await expect(
        git.readCommit({ fs: nodeFs, dir: "/work/repo", oid: nextCommit }),
      ).rejects.toThrow();
    } finally {
      fixture.close();
    }
  });
});

async function initializeFetchRepo(
  fs: ReturnType<typeof createNodeFs>["fs"],
  options: {
    readonly originUrl?: string;
    readonly upstreamUrl?: string;
    readonly branchRemote?: string;
    readonly corsProxy?: string;
  } = {},
): Promise<void> {
  await fs.promises.mkdir("/work/repo", { recursive: true });
  await git.init({ fs, dir: "/work/repo", defaultBranch: "main" });
  await fs.promises.mkdir("/work/repo/subdir", { recursive: true });
  await git.writeRef({
    fs,
    dir: "/work/repo",
    ref: "refs/heads/main",
    value: GIT_FIXTURE_COMMIT,
  });
  await git.setConfig({
    fs,
    dir: "/work/repo",
    path: "remote.origin.url",
    value: options.originUrl ?? "https://git.invalid/origin.git",
  });
  await git.setConfig({
    fs,
    dir: "/work/repo",
    path: "remote.upstream.url",
    value: options.upstreamUrl ?? "https://git.invalid/upstream.git",
  });
  await git.setConfig({
    fs,
    dir: "/work/repo",
    path: "remote.upstream.fetch",
    value: "+refs/heads/*:refs/remotes/upstream/*",
  });
  await git.setConfig({
    fs,
    dir: "/work/repo",
    path: "branch.main.remote",
    value: options.branchRemote ?? "upstream",
  });
  await git.setConfig({
    fs,
    dir: "/work/repo",
    path: "branch.main.merge",
    value: "refs/heads/main",
  });
  if (options.corsProxy !== undefined) {
    await git.setConfig({
      fs,
      dir: "/work/repo",
      path: "http.corsProxy",
      value: options.corsProxy,
    });
  }
}
