// @effect-diagnostics nodeBuiltinImport:off - exercise probe ownership through real native subprocesses.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { runProcess, type RunProcess } from "./process.ts";
import { probeUrl, runProbe } from "./run.ts";
import { withDriver } from "./testing/runDriver.ts";

describe("isolated deployed probe lifecycle", () => {
  it("deploys, measures with private env, retains JSON, and destroys its owned resources", async () => {
    await withDriver("success", async ({ dir, logs, run, requests, events }) => {
      const output = NodePath.join(dir, "proof.json");
      const stage = await runProbe(
        { fixture: ".", output },
        { run, log: (line) => logs.push(line) },
      );
      const recorded = await events();
      expect(recorded.map((event) => event.phase)).toEqual(["deploy", "measure", "destroy"]);
      expect(new Set(recorded.map((event) => event.stage))).toEqual(new Set([stage]));
      expect(new Set(recorded.map((event) => event.hash)).size).toBe(1);
      expect(recorded[1]?.fixture).toBe(process.cwd());
      expect(JSON.parse(await NodeFSP.readFile(output, "utf8"))).toEqual({
        schemaVersion: 1,
        verificationErrors: [],
      });
      expect(await NodeFSP.readdir(dir)).toEqual(
        expect.not.arrayContaining([`${stage}.worker`, `${stage}.namespace`]),
      );
      expect(requests[1]?.args).not.toContain("--url");
      expect(requests[1]?.env.PROBE_URL).toContain(`sb-${stage}.`);
      for (const request of requests) {
        expect(request.args.join(" ")).not.toContain(request.env.PROBE_SECRET);
        expect(logs.join("\n")).not.toContain(request.env.PROBE_SECRET);
      }
      expect(logs.join("\n")).not.toContain("workers.dev");
    });
  });

  it("keeps failed proof JSON and cleans up before returning the measurement error", async () => {
    await withDriver("measure", async ({ dir, run, events }) => {
      const output = NodePath.join(dir, "failed.json");
      await expect(runProbe({ output }, { run, log: () => {} })).rejects.toThrow(
        "measurement exited 9",
      );
      expect(JSON.parse(await NodeFSP.readFile(output, "utf8")).verificationErrors).toEqual([
        "failed proof",
      ]);
      expect((await events()).map((event) => event.phase)).toEqual([
        "deploy",
        "measure",
        "destroy",
      ]);
      expect(await NodeFSP.readdir(dir)).toEqual(["events", "failed.json"]);
    });
  });

  it("destroys a partially deployed Worker without starting measurement", async () => {
    await withDriver("partial", async ({ dir, run, events }) => {
      await expect(runProbe({}, { run, log: () => {} })).rejects.toThrow("deployment exited 7");
      expect((await events()).map((event) => event.phase)).toEqual(["deploy", "destroy"]);
      expect(await NodeFSP.readdir(dir)).toEqual(["events"]);
    });
  });

  it.each(["cleanup", "measure-cleanup"])(
    "reports exact recovery without replacing a primary error: %s",
    async (mode) => {
      await withDriver(mode, async ({ dir, run, logs, events }) => {
        await expect(
          runProbe(
            { output: NodePath.join(dir, "proof.json") },
            { run, log: (line) => logs.push(line) },
          ),
        ).rejects.toThrow(mode === "cleanup" ? "cleanup exited 8" : "measurement exited 9");
        const recorded = await events();
        expect(recorded.map((event) => event.phase)).toEqual(["deploy", "measure", "destroy"]);
        expect(logs.at(-1)).toContain(`--destroy-stage ${recorded[0]?.stage}`);
        expect(logs.join("\n")).not.toContain("workers.dev");
        expect(await NodeFSP.readdir(dir)).toContain(`${recorded[0]?.stage}.worker`);
      });
    },
  );

  it("runs two deployments concurrently with distinct stages and credentials", async () => {
    await withDriver("success", async (first) => {
      await withDriver("success", async (second) => {
        const ready = Promise.withResolvers<void>();
        let deployed = 0;
        const concurrent =
          (run: RunProcess): RunProcess =>
          async (input) => {
            const result = await run(input);
            if (input.args[0] === "deploy") {
              if (++deployed === 2) ready.resolve();
              await ready.promise;
            }
            return result;
          };
        const stages = await Promise.all(
          [first, second].map((context) =>
            runProbe(
              {},
              {
                run: concurrent(context.run),
                log: () => {},
                evidence: () => {},
              },
            ),
          ),
        );
        expect(new Set(stages).size).toBe(2);
        expect(stages.every((stage) => /^isolate-probe-[a-f0-9]{16}$/.test(stage))).toBe(true);
        const events = await Promise.all([first.events(), second.events()]);
        expect(events[0]?.[0]?.hash).not.toBe(events[1]?.[0]?.hash);
        for (const [index, context] of [first, second].entries()) {
          expect(events[index]?.map((event) => event.stage)).toEqual([
            stages[index],
            stages[index],
            stages[index],
          ]);
          expect(await NodeFSP.readdir(context.dir)).toEqual(["events"]);
        }
      });
    });
  });

  it("recovers only the explicitly named hex stage using existing Alchemy state", async () => {
    await withDriver("success", async ({ run, events }) => {
      const stage = "isolate-probe-1234567890abcdef";
      await runProbe({ destroyStage: stage }, { run, log: () => {} });
      expect((await events()).map(({ phase, stage }) => ({ phase, stage }))).toEqual([
        { phase: "destroy", stage },
      ]);
      await expect(runProbe({ destroyStage: "production" }, { run })).rejects.toThrow(
        "exact isolate-probe",
      );
    });
  });

  it("rejects another worker's URL and still destroys the owned stage", async () => {
    await withDriver("success", async ({ run, events }) => {
      const wrongUrl: RunProcess = async (input) => {
        const result = await run(input);
        return input.args[0] === "deploy"
          ? { ...result, stdout: "url: 'https://sb-other.test.workers.dev'" }
          : result;
      };
      await expect(runProbe({}, { run: wrongUrl, log: () => {} })).rejects.toThrow(
        "outside the isolated",
      );
      expect((await events()).map((event) => event.phase)).toEqual(["deploy", "destroy"]);
    });
  });
});

describe("probe subprocess bounds", () => {
  const child = (source: string, signal?: AbortSignal) =>
    runProcess({
      command: process.execPath,
      args: ["-e", source],
      cwd: NodeOS.tmpdir(),
      env: {},
      timeoutMs: 100,
      ...(signal ? { signal } : {}),
    });

  it("stops and reaps a timed out child", async () => {
    await expect(child("setInterval(() => {}, 1000)")).rejects.toThrow("timed out");
  });

  it("stops and reaps a cancelled active child", async () => {
    await expect(
      runProcess({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: NodeOS.tmpdir(),
        env: {},
        timeoutMs: 10_000,
        signal: AbortSignal.timeout(100),
      }),
    ).rejects.toThrow("interrupted");
  });

  it("cleans up after cancellation without passing the aborted signal to destroy", async () => {
    await withDriver("success", async ({ run, events }) => {
      const controller = new AbortController();
      const cancelAfterDeploy: RunProcess = async (input) => {
        const result = await run(input);
        if (input.args[0] === "deploy") controller.abort();
        return result;
      };
      await expect(
        runProbe({ signal: controller.signal }, { run: cancelAfterDeploy, log: () => {} }),
      ).rejects.toThrow("interrupted");
      expect((await events()).map((event) => event.phase)).toEqual(["deploy", "destroy"]);
    });
  });
});

describe("deployed probe URL validation", () => {
  it.each([
    "https://sb-isolate-probe-12345678.evil.workers.dev.evil.test",
    "https://sb-isolate-probe-12345678.other.test",
    "https://sb-isolate-probe-1234567890.account.workers.dev",
    "https://user:password@sb-isolate-probe-12345678.account.workers.dev",
    "https://sb-isolate-probe-12345678.account.workers.dev/run",
  ])("rejects %s", (url) => {
    expect(() => probeUrl(`url: '${url}'`, "isolate-probe-12345678")).toThrow();
  });
});
