import { describe, expect, it } from "@effect/vitest";
import git from "isomorphic-git";
import { createNodeFs } from "../NodeFs.ts";
import { createNodeGitProgram, selectNodeGitRoute } from "../NodeGit.ts";
import {
  createLocalGitRunner,
  createNodeGitFixture,
  finishGit,
  spawnGit,
} from "./helpers/NodeGitFixture.ts";
import { createLocalGitRemote } from "./helpers/NodeGitLocalRemote.ts";

describe("NodeGit explicit fetch refspecs", () => {
  it.each([
    ["main", "prototype"],
    ["refs/heads/main"],
    ["+prototype"],
    ["HEAD"],
    ["refs/tags/v1"],
    ["+main:refs/remotes/origin/custom", "refs/heads/prototype:refs/remotes/origin/other"],
    ["main:custom"],
    ["refs/tags/v1:refs/tags/copied"],
    ["main:"],
    ["--tags", "main"],
    ["--no-tags", "prototype:refs/remotes/origin/other"],
  ])("matches real Git's selected ref updates for %j", async (...refspecs) => {
    const remote = createLocalGitRemote();
    const fixture = createNodeGitFixture();
    const fs = createNodeFs(fixture.filesystem).fs;
    try {
      await fs.promises.mkdir("/work/repo", { recursive: true });
      await git.init({ fs, dir: "/work/repo", defaultBranch: "local" });
      await git.setConfig({
        fs,
        dir: "/work/repo",
        path: "remote.origin.url",
        value: "https://git.invalid/remote.git",
      });
      await git.setConfig({
        fs,
        dir: "/work/repo",
        path: "remote.origin.fetch",
        value: "+refs/heads/*:refs/remotes/origin/*",
      });
      await git.writeRef({
        fs,
        dir: "/work/repo",
        ref: "refs/remotes/origin/unrequested",
        value: remote.oid("main"),
      });
      expect(remote.git(["fetch", "-q", "--no-tags", "origin", "main"]).status).toBe(0);
      expect(
        remote.git(["update-ref", "refs/remotes/origin/unrequested", remote.oid("main")]).status,
      ).toBe(0);
      await git.writeRef({
        fs,
        dir: "/work/repo",
        ref: "refs/remotes/origin/main",
        value: remote.oid("main"),
      });
      const configBefore = await fs.promises.readFile("/work/repo/.git/config", "utf8");
      const program = createNodeGitProgram({ local: createLocalGitRunner(), fetch: remote.fetch });
      const real = remote.git(["fetch", "-q", "origin", ...refspecs]);
      const { host, handle } = await spawnGit(
        fixture.filesystem,
        program,
        ["git", "fetch", "-q", "origin", ...refspecs],
        {},
        "/work/repo",
      );
      const status = await finishGit(host, handle);
      expect(status.exitCode, fixture.stderr()).toBe(real.status);
      expect(fixture.stderr()).toBe(real.stderr.toString());
      const refs = await git.listRefs({ fs, dir: "/work/repo", filepath: "refs" });
      const actual = await Promise.all(
        refs.map(
          async (ref) =>
            `refs/${ref} ${await git.resolveRef({ fs, dir: "/work/repo", ref: `refs/${ref}` })}`,
        ),
      );
      expect(actual.sort()).toEqual(remote.refs());
      expect(await fs.promises.readFile("/work/repo/.git/config", "utf8")).toBe(configBefore);
      for (const ref of refs) {
        const oid = await git.resolveRef({ fs, dir: "/work/repo", ref: `refs/${ref}` });
        await expect(git.readObject({ fs, dir: "/work/repo", oid })).resolves.toHaveProperty(
          "oid",
          oid,
        );
      }
    } finally {
      fixture.close();
      remote.close();
    }
  });

  it.each([["missing"], ["refs/heads/missing"], ["main", "missing"]])(
    "matches real Git's unknown ref error for %j without publishing refs",
    async (...refspecs) => {
      const remote = createLocalGitRemote();
      const fixture = createNodeGitFixture();
      const fs = createNodeFs(fixture.filesystem).fs;
      try {
        await fs.promises.mkdir("/work/repo", { recursive: true });
        await git.init({ fs, dir: "/work/repo" });
        await git.setConfig({
          fs,
          dir: "/work/repo",
          path: "remote.origin.url",
          value: "https://git.invalid/remote.git",
        });
        const real = remote.git(["fetch", "-q", "origin", ...refspecs]);
        const program = createNodeGitProgram({
          local: createLocalGitRunner(),
          fetch: remote.fetch,
        });
        const { host, handle } = await spawnGit(
          fixture.filesystem,
          program,
          ["git", "fetch", "-q", "origin", ...refspecs],
          {},
          "/work/repo",
        );
        expect((await finishGit(host, handle)).exitCode).toBe(real.status);
        expect(fixture.stderr()).toBe(real.stderr.toString());
        expect(await git.listBranches({ fs, dir: "/work/repo", remote: "origin" })).toEqual([]);
        expect(remote.requests.filter((request) => request.startsWith("POST"))).toEqual([]);
      } finally {
        fixture.close();
        remote.close();
      }
    },
  );

  it.each([false, true])(
    "matches real Git when a destination rewinds with force=%s",
    async (force) => {
      const remote = createLocalGitRemote();
      const fixture = createNodeGitFixture();
      const fs = createNodeFs(fixture.filesystem).fs;
      try {
        await fs.promises.mkdir("/work/repo", { recursive: true });
        await git.init({ fs, dir: "/work/repo", defaultBranch: "local" });
        await git.setConfig({
          fs,
          dir: "/work/repo",
          path: "remote.origin.url",
          value: "https://git.invalid/remote.git",
        });
        await git.setConfig({
          fs,
          dir: "/work/repo",
          path: "remote.origin.fetch",
          value: "+refs/heads/*:refs/remotes/origin/*",
        });
        const program = createNodeGitProgram({
          local: createLocalGitRunner(),
          fetch: remote.fetch,
        });
        const run = async (refspec: string) => {
          const { host, handle } = await spawnGit(
            fixture.filesystem,
            program,
            ["git", "fetch", "-q", "--no-tags", "origin", refspec],
            {},
            "/work/repo",
          );
          return finishGit(host, handle);
        };
        const refspec = "prototype:refs/heads/topic";
        expect(remote.git(["fetch", "-q", "--no-tags", "origin", refspec]).status).toBe(0);
        expect((await run(refspec)).exitCode, fixture.stderr()).toBe(0);
        remote.remoteGit(["update-ref", "refs/heads/prototype", remote.oid("main")]);
        const forced = `${force ? "+" : ""}${refspec}`;
        const real = remote.git(["fetch", "-q", "--no-tags", "origin", forced]);
        expect((await run(forced)).exitCode).toBe(real.status);
        const refs = await git.listRefs({ fs, dir: "/work/repo", filepath: "refs" });
        const actual = await Promise.all(
          refs.map(
            async (ref) =>
              `refs/${ref} ${await git.resolveRef({ fs, dir: "/work/repo", ref: `refs/${ref}` })}`,
          ),
        );
        expect(actual.sort()).toEqual(remote.refs());
      } finally {
        fixture.close();
        remote.close();
      }
    },
  );

  it("negotiates from the selected tracking refs without local branches", async () => {
    const remote = createLocalGitRemote();
    const fixture = createNodeGitFixture();
    const fs = createNodeFs(fixture.filesystem).fs;
    try {
      await fs.promises.mkdir("/work/repo", { recursive: true });
      await git.init({ fs, dir: "/work/repo", defaultBranch: "local" });
      await git.setConfig({
        fs,
        dir: "/work/repo",
        path: "remote.origin.url",
        value: "https://git.invalid/remote.git",
      });
      await git.setConfig({
        fs,
        dir: "/work/repo",
        path: "remote.origin.fetch",
        value: "+refs/heads/*:refs/remotes/origin/*",
      });
      const program = createNodeGitProgram({ local: createLocalGitRunner(), fetch: remote.fetch });
      const fetch = async () => {
        const { host, handle } = await spawnGit(
          fixture.filesystem,
          program,
          ["git", "fetch", "-q", "origin", "main", "prototype"],
          {},
          "/work/repo",
        );
        return finishGit(host, handle);
      };
      expect((await fetch()).exitCode, fixture.stderr()).toBe(0);
      expect(await git.listBranches({ fs, dir: "/work/repo" })).toEqual([]);
      remote.uploadRequests.length = 0;
      expect((await fetch()).exitCode, fixture.stderr()).toBe(0);
      for (const branch of ["main", "prototype"]) {
        const oid = remote.oid(branch);
        const request = remote.uploadRequests.find((body) => body.includes(`want ${oid} `));
        expect(request).toContain(`have ${oid}\n`);
      }
    } finally {
      fixture.close();
      remote.close();
    }
  });

  it("routes supported forms and names unsupported forms", () => {
    expect(
      selectNodeGitRoute([
        "git",
        "fetch",
        "-q",
        "origin",
        "main",
        "+refs/heads/prototype:refs/remotes/origin/prototype",
      ]),
    ).toMatchObject({
      kind: "fetch",
      quiet: true,
      refspecs: ["main", "+refs/heads/prototype:refs/remotes/origin/prototype"],
    });
    for (const [refspec, form] of [
      ["refs/heads/*:refs/remotes/origin/*", "glob"],
      ["^main", "negative"],
    ]) {
      expect(selectNodeGitRoute(["git", "fetch", "origin", refspec!])).toMatchObject({
        kind: "reject",
        exitCode: 129,
        message: expect.stringContaining(`${form} refspec`),
      });
    }
  });
});
