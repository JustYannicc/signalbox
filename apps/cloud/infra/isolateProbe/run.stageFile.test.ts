// @effect-diagnostics nodeBuiltinImport:off - verify cancellation recovery against owned temporary files and subprocesses.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { runProbe } from "./run.ts";
import { stageFile } from "./stageFile.ts";
import { withDriver } from "./testing/runDriver.ts";

describe("probe stage-file lifecycle", () => {
  it.each(["success", "partial", "measure"])(
    "records the random stage before deployment and removes it after cleanup: %s",
    async (mode) => {
      await withDriver(mode, async ({ dir, run, requests }) => {
        const path = NodePath.join(dir, "stage");
        const probe = runProbe(
          { stageFile: path, output: NodePath.join(dir, "proof.json") },
          {
            log: () => {},
            run: async (input) => {
              if (input.args[0] === "deploy") {
                const claimed = await NodeFSP.readFile(path, "utf8");
                expect(claimed).toBe(`${input.args[input.args.indexOf("--stage") + 1]}\n`);
                expect((await NodeFSP.stat(path)).mode & 0o777).toBe(0o600);
                expect(claimed).not.toContain(input.env.PROBE_SECRET);
              }
              return run(input);
            },
          },
        );
        if (mode === "success") await probe;
        else
          await expect(probe).rejects.toThrow(
            mode === "partial" ? "deployment exited 7" : "measurement exited 9",
          );
        await expect(NodeFSP.stat(path)).rejects.toThrow("ENOENT");
        expect(requests.at(-1)?.args[0]).toBe("destroy");
      });
    },
  );

  it("always-step recovery destroys only the saved stage after interruption before finally", async () => {
    await withDriver("success", async ({ dir, run, events }) => {
      const path = NodePath.join(dir, "stage");
      const stage = "isolate-probe-1234567890abcdef";
      const claim = await stageFile(path, stage);
      await claim.close();
      await NodeFSP.writeFile(NodePath.join(dir, `${stage}.worker`), "partial deployment");
      await runProbe({ recoverStageFile: path }, { run, log: () => {} });
      expect((await events()).map(({ phase, stage }) => ({ phase, stage }))).toEqual([
        { phase: "destroy", stage },
      ]);
      expect(await NodeFSP.readdir(dir)).toEqual(["events"]);
    });
  });

  it("retains failed cleanup ownership and refuses an automatic blind retry", async () => {
    await withDriver("measure-cleanup", async ({ dir, run, requests }) => {
      const path = NodePath.join(dir, "stage");
      const logs: string[] = [];
      await expect(
        runProbe(
          { stageFile: path, output: NodePath.join(dir, "proof.json") },
          {
            run,
            log: (line) => logs.push(line),
          },
        ),
      ).rejects.toThrow("measurement exited 9");
      expect(await NodeFSP.readFile(path, "utf8")).toMatch(
        /^isolate-probe-[a-f0-9]{16}\ncleanup-failed\n$/,
      );
      expect(logs.join("\n")).toContain("cleanup exited 8");
      expect(
        JSON.parse(await NodeFSP.readFile(NodePath.join(dir, "proof.json"), "utf8"))
          .verificationErrors,
      ).toEqual(["failed proof"]);
      const count = requests.length;
      await expect(runProbe({ recoverStageFile: path }, { run })).rejects.toThrow(
        "Recover manually:",
      );
      expect(requests).toHaveLength(count);
    });
  });

  it("never overwrites an existing claim or follows a symlink", async () => {
    await withDriver("success", async ({ dir, run, requests }) => {
      const path = NodePath.join(dir, "stage");
      await NodeFSP.writeFile(path, "someone else's claim", { mode: 0o600 });
      await expect(runProbe({ stageFile: path }, { run })).rejects.toThrow("EEXIST");
      expect(await NodeFSP.readFile(path, "utf8")).toBe("someone else's claim");
      const link = NodePath.join(dir, "symlink");
      await NodeFSP.symlink(path, link);
      await expect(runProbe({ recoverStageFile: link }, { run })).rejects.toThrow();
      expect(requests).toEqual([]);
    });
  });

  it.each(["public", "mismatch", "replaced"])(
    "rejects an unowned or changed claim: %s",
    async (mode) => {
      await withDriver("success", async ({ dir, run, requests }) => {
        const path = NodePath.join(dir, "stage");
        const stage = "isolate-probe-1234567890abcdef";
        const claim = await stageFile(path, stage);
        try {
          if (mode === "public") {
            await NodeFSP.chmod(path, 0o644);
            await expect(runProbe({ recoverStageFile: path }, { run })).rejects.toThrow(
              "mode 0600",
            );
          } else if (mode === "mismatch") {
            await expect(
              runProbe({ destroyStage: "isolate-probe-abcdef12", stageFile: path }, { run }),
            ).rejects.toThrow("does not authorize");
          } else {
            await NodeFSP.rename(path, `${path}.old`);
            await NodeFSP.writeFile(path, "replacement", { mode: 0o600 });
            await expect(claim.remove()).rejects.toThrow("replaced");
            expect(await NodeFSP.readFile(path, "utf8")).toBe("replacement");
          }
          expect(requests).toEqual([]);
        } finally {
          await claim.close();
        }
      });
    },
  );
});
