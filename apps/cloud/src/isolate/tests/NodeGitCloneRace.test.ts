import { describe, expect, it } from "@effect/vitest";
import { createNodeFs } from "../NodeFs.ts";
import { withCloneGitDirectoryClaim } from "../node/git/transport.ts";
import type { NodeGitFsClient } from "../node/git/filesystem.ts";
import { createNodeGitFixture, deferred } from "./helpers/NodeGitFixture.ts";

describe("NodeGit clone directory claim", () => {
  it("lets one overlapping clone own .git and keeps its work after the other fails", async () => {
    const fixture = createNodeGitFixture();
    const baseFs = createNodeFs(fixture.filesystem).fs as NodeGitFsClient;
    await baseFs.promises.mkdir("/work/racing");

    const preflight = deferred<void>();
    const releaseWinner = deferred<void>();
    const winnerEntered = deferred<void>();
    const cloneFailed = deferred<unknown>();
    const readDirectory = baseFs.promises.readdir;
    let reads = 0;
    let winnerFinished = false;
    const fs = {
      ...baseFs,
      promises: {
        ...baseFs.promises,
        readdir: async (path: string) => {
          const entries = await readDirectory(path);
          if (path === "/work/racing") {
            reads += 1;
            if (reads === 2) preflight.resolve();
            await preflight.promise;
          }
          return entries;
        },
      },
    } as NodeGitFsClient;

    const attempt = async () => {
      try {
        return await withCloneGitDirectoryClaim(fs, "/work/racing", async () => {
          winnerEntered.resolve();
          await releaseWinner.promise;
          await baseFs.promises.writeFile("/work/racing/.git/winner", "owned");
          winnerFinished = true;
          return "cloned";
        });
      } catch (error) {
        cloneFailed.resolve(error);
        throw error;
      }
    };

    try {
      const attempts = [attempt(), attempt()];
      await winnerEntered.promise;
      const failure = await cloneFailed.promise;
      expect(failure).toMatchObject({ code: "EEXIST" });
      expect(winnerFinished).toBe(false);

      releaseWinner.resolve();
      const results = await Promise.allSettled(attempts);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(await baseFs.promises.readFile("/work/racing/.git/winner", "utf8")).toBe("owned");
    } finally {
      releaseWinner.resolve();
      fixture.close();
    }
  });
});
