import { describe, expect, it } from "@effect/vitest";
import { createNodeFs } from "../NodeFs.ts";
import { createNodeGitProgram } from "../NodeGit.ts";
import {
  createLocalGitRunner,
  createNodeGitFixture,
  createSmartHttpServer,
  finishGit,
  spawnGit,
} from "./helpers/NodeGitFixture.ts";

describe("NodeGit checkout failures", () => {
  it("propagates EACCES and removes owned Git metadata after checkout writes settle", async () => {
    const fixture = createNodeGitFixture();
    const nodeFs = createNodeFs(fixture.filesystem).fs;
    const server = createSmartHttpServer({ authenticate: false });
    let processFilesystem: typeof fixture.filesystem | undefined;
    let deniedCheckoutWrite = false;
    await nodeFs.promises.mkdir("/work/checkout-fails");

    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if ((init?.method ?? "GET") === "POST" && url.pathname.endsWith("/git-upload-pack")) {
        processFilesystem?.chmod("/work/checkout-fails", 0o555);
      }
      return server.fetch(input, init);
    };
    const program = createNodeGitProgram({ local: createLocalGitRunner(), fetch });

    try {
      const { host, handle } = await spawnGit(
        fixture.filesystem,
        program,
        ["/usr/bin/git", "clone", "https://git.invalid/remote.git", "checkout-fails"],
        {},
        "/work",
        undefined,
        (filesystem) => {
          processFilesystem = filesystem;
          const originalOpen = filesystem.open.bind(filesystem);
          filesystem.open = (path, flags, mode) => {
            if (path.endsWith("checkout-fails/README.md") && (flags & 3) !== 0) {
              deniedCheckoutWrite = true;
              filesystem.chmod("/work/checkout-fails", 0o755);
              throw Object.assign(
                new Error("EACCES: permission denied while checking out README.md"),
                {
                  code: "EACCES",
                },
              );
            }
            return originalOpen(path, flags, mode);
          };
        },
      );
      const status = await finishGit(host, handle);

      expect(deniedCheckoutWrite).toBe(true);
      expect(status.exitCode).toBe(128);
      expect(fixture.stderr()).toContain("EACCES");
      expect(nodeFs.existsSync("/work/checkout-fails/.git")).toBe(false);
      expect(nodeFs.existsSync("/work/checkout-fails/README.md")).toBe(false);
      expect(await nodeFs.promises.readdir("/work/checkout-fails")).toEqual(["run.sh"]);
      expect(fixture.filesystem.getPosixMetadata("/work/checkout-fails").mode).toBe(0o755);
    } finally {
      fixture.close();
    }
  });
});
