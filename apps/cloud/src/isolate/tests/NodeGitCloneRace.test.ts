import { describe, expect, it } from "@effect/vitest";
import { createNodeFs } from "../NodeFs.ts";
import { createNodeGitProgram } from "../NodeGit.ts";
import {
  createLocalGitRunner,
  createNodeGitFixture,
  createSmartHttpServer,
  deferred,
  finishGit,
  spawnGit,
} from "./helpers/NodeGitFixture.ts";

describe("NodeGit HTTP clone", () => {
  it("keeps the first clone intact when an overlapping clone fails before its first request", async () => {
    const fixture = createNodeGitFixture();
    const fs = createNodeFs(fixture.filesystem).fs;
    const server = createSmartHttpServer({ authenticate: false });
    const uploadPackStarted = deferred<void>();
    const releaseUploadPack = deferred<void>();
    let uploadPackRequests = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if ((init?.method ?? "GET") === "POST" && url.pathname.endsWith("/git-upload-pack")) {
        uploadPackRequests += 1;
        if (uploadPackRequests === 1) {
          uploadPackStarted.resolve();
          await releaseUploadPack.promise;
        }
      }
      return server.fetch(input, init);
    };
    const program = () => createNodeGitProgram({ local: createLocalGitRunner(), fetch });
    let winnerCompletion: ReturnType<typeof finishGit> | undefined;

    try {
      const winner = await spawnGit(fixture.filesystem, program(), [
        "/usr/bin/git",
        "clone",
        "https://git.invalid/remote.git",
        "racing",
      ]);
      winnerCompletion = finishGit(winner.host, winner.handle);
      await uploadPackStarted.promise;
      const requestCount = server.requests.length;

      const loser = await spawnGit(fixture.filesystem, program(), [
        "/usr/bin/git",
        "clone",
        "https://git.invalid/remote.git",
        "racing",
      ]);
      const loserStatus = await finishGit(loser.host, loser.handle);

      expect(loserStatus.exitCode).toBe(128);
      expect(fixture.stderr()).toContain("destination path 'racing' already exists");
      expect(server.requests).toHaveLength(requestCount);
      expect(uploadPackRequests).toBe(1);

      releaseUploadPack.resolve();
      const winnerStatus = await winnerCompletion;
      winnerCompletion = undefined;
      expect(winnerStatus.exitCode, fixture.stderr()).toBe(0);
      expect(await fs.promises.readFile("/work/racing/README.md", "utf8")).toBe("remote README\n");
    } finally {
      releaseUploadPack.resolve();
      if (winnerCompletion !== undefined) await winnerCompletion.catch(() => undefined);
      fixture.close();
    }
  });
});
