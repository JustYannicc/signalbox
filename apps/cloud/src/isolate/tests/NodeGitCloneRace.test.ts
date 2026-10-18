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
  it("keeps one public clone intact when both see an empty destination", async () => {
    const fixture = createNodeGitFixture();
    const fs = createNodeFs(fixture.filesystem).fs;
    const server = createSmartHttpServer({ authenticate: false });
    const bothPreflights = deferred<void>();
    const observedEntries: string[][] = [];
    const program = () =>
      createNodeGitProgram({ local: createLocalGitRunner(), fetch: server.fetch });

    await fs.promises.mkdir("/work/racing");

    const onProcessFilesystem: NonNullable<Parameters<typeof spawnGit>[6]> = (
      processFilesystem,
    ) => {
      const readdir = processFilesystem.readdir.bind(processFilesystem);
      let observedDestinationPreflight = false;

      processFilesystem.readdir = ((path: string) => {
        const entries = readdir(path);
        if (path !== "racing" || observedDestinationPreflight) return entries;

        observedDestinationPreflight = true;
        observedEntries.push(entries);
        if (observedEntries.length === 2) bothPreflights.resolve();

        // The async fs bridge awaits this real syscall's return, so both clones hold their snapshots.
        return bothPreflights.promise.then(() => entries);
      }) as unknown as typeof processFilesystem.readdir;
    };

    const clone = () =>
      spawnGit(
        fixture.filesystem,
        program(),
        ["/usr/bin/git", "clone", "https://git.invalid/remote.git", "racing"],
        {},
        "/work",
        undefined,
        onProcessFilesystem,
      );

    const attempts: Array<ReturnType<typeof finishGit>> = [];
    try {
      const spawned = await Promise.all([clone(), clone()]);
      attempts.push(...spawned.map(({ host, handle }) => finishGit(host, handle)));
      const statuses = await Promise.all(attempts);

      expect(observedEntries).toEqual([[], []]);
      expect(statuses.map(({ exitCode }) => exitCode).sort((a, b) => a - b)).toEqual([0, 128]);
      expect(server.requests.map(({ method }) => method).sort()).toEqual(["GET", "POST"]);
      expect(fixture.stderr()).toContain("already exists");

      expect(await fs.promises.readFile("/work/racing/README.md", "utf8")).toBe("remote README\n");
    } finally {
      await Promise.allSettled(attempts);
      fixture.close();
    }
  });
});
