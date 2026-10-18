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
  spawnGit,
} from "./helpers/NodeGitFixture.ts";
import { forwardRefDeltaPack, invalidPackFixtures } from "./helpers/NodeGitPackFixture.ts";

describe("NodeGit HTTP pack validation", () => {
  it("indexes a valid forward-reference delta pack", async () => {
    const pack = forwardRefDeltaPack("base", "!");
    const run = await runFetch(pack.pack, pack.targetOid);
    try {
      expect(run.status.exitCode, run.fixture.stderr()).toBe(0);
      expect(
        await git.resolveRef({
          fs: run.fs,
          dir: "/work/repo",
          ref: "refs/remotes/upstream/main",
        }),
      ).toBe(pack.targetOid);
      const base = await git.readBlob({ fs: run.fs, dir: "/work/repo", oid: pack.baseOid });
      const target = await git.readBlob({ fs: run.fs, dir: "/work/repo", oid: pack.targetOid });
      expect(new TextDecoder().decode(base.blob)).toBe("base");
      expect(new TextDecoder().decode(target.blob)).toBe("base!");
    } finally {
      run.fixture.close();
    }
  });

  it("fails a reconstructed-object budget error before publishing pack state", async () => {
    const pack = forwardRefDeltaPack("base", "!");
    const run = await runFetch(pack.pack, "1111111111111111111111111111111111111111", {
      maxObjectBytes: 64,
      maxTotalObjectBytes: 14,
    });
    try {
      expect(run.status.exitCode).toBe(128);
      expect(run.fixture.stderr()).toContain("configured 14-byte object budget");
      await expectUnpublishedPack(run.fs);
    } finally {
      run.fixture.close();
    }
  });

  it("fails an oversized reconstructed delta before publishing pack state", async () => {
    const pack = forwardRefDeltaPack("0123456789abcdef", "!");
    const run = await runFetch(pack.pack, "1111111111111111111111111111111111111111", {
      maxObjectBytes: 16,
      maxTotalObjectBytes: 128,
    });
    try {
      expect(run.status.exitCode).toBe(128);
      expect(run.fixture.stderr()).toContain("configured 16-byte limit");
      await expectUnpublishedPack(run.fs);
    } finally {
      run.fixture.close();
    }
  });

  it("rejects truncated objects, mismatched counts, and missing or corrupt trailers", async () => {
    for (const invalid of invalidPackFixtures()) {
      const run = await runFetch(invalid.pack, "1111111111111111111111111111111111111111");
      try {
        expect(run.status.exitCode, invalid.name).toBe(128);
        await expectUnpublishedPack(run.fs);
      } finally {
        run.fixture.close();
      }
    }
  });

  it("does not publish refs after a fatal sideband following NAK", async () => {
    const run = await runFetch(
      undefined,
      "1111111111111111111111111111111111111111",
      {},
      {
        fatalSideband: "fixture fatal sideband",
      },
    );
    try {
      expect(run.status.exitCode).toBe(128);
      expect(run.fixture.stderr()).toContain("fixture fatal sideband");
      await expectUnpublishedPack(run.fs);
    } finally {
      run.fixture.close();
    }
  });
});

async function runFetch(
  pack: Uint8Array | undefined,
  commit: string,
  budgets: { readonly maxObjectBytes?: number; readonly maxTotalObjectBytes?: number } = {},
  serverOptions: { readonly fatalSideband?: string } = {},
) {
  const fixture = createNodeGitFixture();
  const fs = createNodeFs(fixture.filesystem).fs;
  await initializeFetchRepo(fs);
  const server = createSmartHttpServer({
    authenticate: false,
    commit,
    ...(pack === undefined ? {} : { pack }),
    ...serverOptions,
  });
  const program = createNodeGitProgram({
    local: createLocalGitRunner(),
    fetch: server.fetch,
    ...budgets,
  });
  const { host, handle } = await spawnGit(fixture.filesystem, program, [
    "/usr/bin/git",
    "-C",
    "repo",
    "fetch",
    "upstream",
  ]);
  const status = await finishGit(host, handle);
  return { fixture, fs, status };
}

async function initializeFetchRepo(fs: ReturnType<typeof createNodeFs>["fs"]): Promise<void> {
  await fs.promises.mkdir("/work/repo", { recursive: true });
  await git.init({ fs, dir: "/work/repo", defaultBranch: "main" });
  await git.setConfig({
    fs,
    dir: "/work/repo",
    path: "remote.upstream.url",
    value: "https://git.invalid/upstream.git",
  });
  await git.setConfig({
    fs,
    dir: "/work/repo",
    path: "remote.upstream.fetch",
    value: "+refs/heads/*:refs/remotes/upstream/*",
  });
  await git.writeRef({
    fs,
    dir: "/work/repo",
    ref: "refs/remotes/upstream/main",
    value: GIT_FIXTURE_COMMIT,
  });
}

async function expectUnpublishedPack(fs: ReturnType<typeof createNodeFs>["fs"]): Promise<void> {
  expect(await git.resolveRef({ fs, dir: "/work/repo", ref: "refs/remotes/upstream/main" })).toBe(
    GIT_FIXTURE_COMMIT,
  );
  expect(await fs.promises.readdir("/work/repo/.git/objects/pack")).toEqual([]);
}
