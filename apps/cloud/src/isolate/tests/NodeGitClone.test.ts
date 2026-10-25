import { describe, expect, it } from "@effect/vitest";
import git from "isomorphic-git";
import { createNodeFs } from "../NodeFs.ts";
import { createNodeGitProgram } from "../NodeGit.ts";
import {
  createLocalGitRunner,
  createNodeGitFixture,
  createSmartHttpServer,
  deferred,
  finishGit,
  GIT_FIXTURE_COMMIT,
  spawnGit,
} from "./helpers/NodeGitFixture.ts";

describe("NodeGit HTTP clone", () => {
  it("clones through real smart HTTP into canonical SQLite storage with cwd and modes intact", async () => {
    const fixture = createNodeGitFixture();
    const server = createSmartHttpServer({ authenticate: true });
    let authCalls = 0;
    let localCalls = 0;
    try {
      const program = createNodeGitProgram({
        local: createLocalGitRunner(() => (localCalls += 1)),
        onAuth: (url) => {
          authCalls += 1;
          expect(url).toBe("https://git.invalid/remote.git");
          return { username: "fixture-user", password: "caller-secret" };
        },
        fetch: server.fetch,
      });
      const { host, handle } = await spawnGit(
        fixture.filesystem,
        program,
        [
          "/usr/bin/git",
          "-C",
          "nested",
          "clone",
          "--branch",
          "main",
          "https://git.invalid/remote.git",
          "repo",
        ],
        { GITHUB_TOKEN: "must-not-be-read" },
      );
      const status = await finishGit(host, handle);

      expect(status.exitCode, fixture.stderr()).toBe(0);
      expect(status.signal).toBe(0);
      expect(localCalls).toBe(0);
      expect(authCalls).toBeGreaterThan(0);
      expect(server.requests.map(({ method }) => method)).toEqual(["GET", "GET", "POST"]);
      expect(server.cancelledUnauthorizedBodies).toBe(1);
      expect(
        server.requests.slice(1).every(({ authorization }) => authorization?.startsWith("Basic ")),
      ).toBe(true);

      const nodeFs = createNodeFs(fixture.filesystem).fs;
      expect(await nodeFs.promises.readFile("/work/nested/repo/README.md", "utf8")).toBe(
        "remote README\n",
      );
      expect(fixture.filesystem.getPosixMetadata("/work/nested/repo/run.sh").mode).toBe(0o755);
      expect(fixture.filesystem.getPosixMetadata("/work/nested/repo/README.md").mode).toBe(0o644);
      expect(await nodeFs.promises.readFile("/README.md", "utf8")).toBe("root decoy\n");
      expect(await nodeFs.promises.readFile("/work/README.md", "utf8")).toBe("cwd decoy\n");

      const object = await git.readBlob({
        fs: nodeFs,
        dir: "/work/nested/repo",
        oid: GIT_FIXTURE_COMMIT,
        filepath: "README.md",
      });
      expect(new TextDecoder().decode(object.blob)).toBe("remote README\n");
    } finally {
      fixture.close();
    }
  });

  it("keeps transport errors local and does not invoke the injected WASM runner", async () => {
    const fixture = createNodeGitFixture();
    let localCalls = 0;
    try {
      const program = createNodeGitProgram({
        local: createLocalGitRunner(() => (localCalls += 1)),
        fetch: async () => {
          throw new Error("fixture transport failed");
        },
      });
      const { host, handle } = await spawnGit(fixture.filesystem, program, [
        "/usr/bin/git",
        "clone",
        "https://git.invalid/remote.git",
        "failed",
      ]);
      const status = await finishGit(host, handle);

      expect(status.exitCode).toBe(128);
      expect(fixture.stderr()).toContain("fixture transport failed");
      expect(localCalls).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it("refuses to clone over an existing destination without changing it", async () => {
    const fixture = createNodeGitFixture();
    const server = createSmartHttpServer({ authenticate: false });
    const nodeFs = createNodeFs(fixture.filesystem).fs;
    await nodeFs.promises.mkdir("/work/existing");
    await nodeFs.promises.writeFile("/work/existing/keep.txt", "user data\n");
    try {
      const program = createNodeGitProgram({
        local: createLocalGitRunner(),
        fetch: server.fetch,
      });
      const { host, handle } = await spawnGit(fixture.filesystem, program, [
        "/usr/bin/git",
        "clone",
        "https://git.invalid/remote.git",
        "existing",
      ]);
      const status = await finishGit(host, handle);

      expect(status.exitCode).toBe(128);
      expect(fixture.stderr()).toContain("destination path 'existing' already exists");
      expect(server.requests).toEqual([]);
      expect(await nodeFs.promises.readFile("/work/existing/keep.txt", "utf8")).toBe("user data\n");
    } finally {
      fixture.close();
    }
  });

  it("clones into an existing empty destination directory", async () => {
    const fixture = createNodeGitFixture();
    const server = createSmartHttpServer({ authenticate: false });
    const nodeFs = createNodeFs(fixture.filesystem).fs;
    await nodeFs.promises.mkdir("/work/empty");
    try {
      const program = createNodeGitProgram({
        local: createLocalGitRunner(),
        fetch: server.fetch,
      });
      const { host, handle } = await spawnGit(fixture.filesystem, program, [
        "/usr/bin/git",
        "clone",
        "https://git.invalid/remote.git",
        "empty",
      ]);
      const status = await finishGit(host, handle);

      expect(status.exitCode, fixture.stderr()).toBe(0);
      expect(server.requests.length).toBeGreaterThan(0);
      expect(await git.resolveRef({ fs: nodeFs, dir: "/work/empty", ref: "refs/heads/main" })).toBe(
        GIT_FIXTURE_COMMIT,
      );
    } finally {
      fixture.close();
    }
  });

  it("fails on a read-only canonical mount before making an HTTP request", async () => {
    const fixture = createNodeGitFixture(true);
    let requests = 0;
    try {
      expect(fixture.filesystem.getPosixMetadata("/work/readonly").mode).toBe(0o755);
      expect(() =>
        createNodeFs(fixture.filesystem).fs.writeFileSync("/work/readonly/probe", "x"),
      ).toThrow(expect.objectContaining({ code: "EROFS" }));
      const program = createNodeGitProgram({
        local: createLocalGitRunner(),
        fetch: async () => {
          requests += 1;
          return new Response();
        },
      });
      const { host, handle } = await spawnGit(fixture.filesystem, program, [
        "/usr/bin/git",
        "clone",
        "https://git.invalid/remote.git",
        "readonly",
      ]);
      const status = await finishGit(host, handle);

      expect(status.exitCode).not.toBe(0);
      expect(fixture.stderr()).not.toBe("");
      expect(requests).toBe(0);
      const nodeFs = createNodeFs(fixture.filesystem).fs;
      expect(nodeFs.existsSync("/work/readonly")).toBe(true);
      expect(nodeFs.existsSync("/work/readonly/.git")).toBe(false);
    } finally {
      fixture.close();
    }
  });

  it("aborts the in-flight HTTP request and removes the partial clone", async () => {
    const fixture = createNodeGitFixture();
    const started = deferred<AbortSignal>();
    let aborted = false;
    const controller = new AbortController();
    try {
      const program = createNodeGitProgram({
        local: createLocalGitRunner(),
        fetch: (_input, init) => {
          const signal = init?.signal;
          if (!(signal instanceof AbortSignal))
            throw new Error("Fetch did not receive cancellation");
          started.resolve(signal);
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          });
        },
      });
      const { host, handle } = await spawnGit(
        fixture.filesystem,
        program,
        ["/usr/bin/git", "clone", "https://git.invalid/remote.git", "cancelled"],
        {},
        "/work",
        controller.signal,
      );
      const statusPromise = host.exitStatus(handle);
      await started.promise;
      controller.abort(new DOMException("Cancelled by fixture", "AbortError"));
      const status = await statusPromise;

      expect(status).toMatchObject({ status: "error", error: { code: "CANCELLED" } });
      expect(aborted).toBe(true);
      expect(createNodeFs(fixture.filesystem).fs.existsSync("/work/cancelled/.git")).toBe(false);
      expect(host.reap(handle)).toMatchObject({ status: "error", error: { code: "CANCELLED" } });
      expect(host.processes.size).toBe(0);
      expect(host.wakes.size).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it("checks process cancellation before checkout writes and still cleans its owned Git directory", async () => {
    const fixture = createNodeGitFixture();
    const server = createSmartHttpServer({ authenticate: false });
    const controller = new AbortController();
    let cancelledAtPackIndex = false;
    let writesAfterCancellation = 0;
    try {
      const program = createNodeGitProgram({ local: createLocalGitRunner(), fetch: server.fetch });
      const { host, handle } = await spawnGit(
        fixture.filesystem,
        program,
        ["/usr/bin/git", "clone", "https://git.invalid/remote.git", "cancel-at-index"],
        {},
        "/work",
        controller.signal,
        (filesystem) => {
          const originalWrite = filesystem.write.bind(filesystem);
          filesystem.write = (fd, source, position) => {
            if (controller.signal.aborted) writesAfterCancellation += 1;
            const descriptor = filesystem.descriptors.get(fd);
            const path =
              descriptor.kind === "file" ? descriptor.pathComponents?.join("/") : undefined;
            const written = originalWrite(fd, source, position);
            if (!controller.signal.aborted && path?.endsWith(".idx")) {
              cancelledAtPackIndex = true;
              controller.abort(new DOMException("Cancel before checkout", "AbortError"));
            }
            return written;
          };
        },
      );
      const status = await host.exitStatus(handle);
      expect(cancelledAtPackIndex).toBe(true);
      expect(status).toMatchObject({ status: "error", error: { code: "CANCELLED" } });
      expect(writesAfterCancellation).toBe(0);
      const nodeFs = createNodeFs(fixture.filesystem).fs;
      expect(nodeFs.existsSync("/work/cancel-at-index/.git")).toBe(false);
      expect(nodeFs.readdirSync("/work/cancel-at-index")).toEqual([]);
      expect(host.reap(handle)).toMatchObject({ status: "error", error: { code: "CANCELLED" } });
      expect(host.processes.size).toBe(0);
      expect(host.wakes.size).toBe(0);
    } finally {
      fixture.close();
    }
  });
});
