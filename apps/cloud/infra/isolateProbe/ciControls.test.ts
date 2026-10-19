// @effect-diagnostics nodeBuiltinImport:off - exercise standalone Node CI tooling with isolated temporary files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it, vi } from "@effect/vitest";
import { Cloudflare } from "./ciCloudflare.ts";
import { startCold } from "./ciRequests.ts";
import {
  classify,
  discoverActiveActor,
  runControls,
  successfulControls,
  type ControlDependencies,
} from "./ciControls.ts";
import { json, writeJson } from "./ciArchive.ts";

const cwdEvidence = () => ({
  runId: "a".repeat(16),
  verificationErrors: ["/startup: behavioral assertion failed"],
  rows: [
    {
      cold: true,
      path: "/startup",
      response: {
        result: {
          ok: false,
          exit: 1,
          stderr: "Error: set engine working directory\nNo such file or directory (os error 44)",
          totalPeakMemoryUnavailable: "workerd does not expose total isolate memory in this host",
        },
      },
    },
  ],
});
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) await NodeFSP.rm(dir, { recursive: true, force: true });
});
async function setup() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "probe-ci-controls-"));
  directories.push(root);
  const output = NodePath.join(root, "artifacts");
  await NodeFSP.mkdir(output);
  const ledger = NodePath.join(output, "owned-workers.json");
  const cloud = new Cloudflare("a".repeat(32), "fake-ci-token");
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const deploy = vi.spyOn(cloud, "deploy").mockImplementation(async (owner) => {
    owner.namespace = `namespace-${owner.script}`;
    owner.version = "version";
    return `https://${owner.script}.private.workers.dev`;
  });
  vi.spyOn(cloud, "actor").mockImplementation(async (owner) => {
    owner.actor = "a".repeat(64);
    return owner.actor;
  });
  const cleanup = vi.spyOn(cloud, "cleanup").mockImplementation(async (owner) => {
    owner.deleted = true;
  });
  return { root, output, ledger, cloud, deploy, cleanup };
}

it("distinguishes returned cwd error 44, OOM, and other failures", () => {
  expect(classify(cwdEvidence())).toBe("cwd44");
  expect(classify({ rows: [{ response: { error: "Memory limit exceeded" } }] })).toBe("oom");
  expect(classify({ rows: [{ response: { result: { exit: 44, stderr: "cwd" } } }] })).toBe("other");
  expect(classify({ error: "HTTP 503" })).toBe("other");
  expect(classify({ rows: [{ response: { error: "isolate exhausted memory" } }] })).toBe("oom");
});

it("bounds actor discovery while one cold request runs and stops when it completes", async () => {
  const { cloud } = await setup();
  const actor = vi
    .spyOn(cloud, "actor")
    .mockResolvedValueOnce(undefined)
    .mockResolvedValue("a".repeat(64));
  const owner = { script: `sb-isolate-probe-${"a".repeat(24)}` };
  const wait = vi.fn(async () => {});
  const running = new Promise<void>(() => {});
  expect((await discoverActiveActor(cloud, owner, running, wait)).actor).toBe("a".repeat(64));
  expect(wait).toHaveBeenCalledTimes(1);
  actor.mockResolvedValue(undefined);
  actor.mockClear();
  expect((await discoverActiveActor(cloud, owner, Promise.resolve(), wait)).actor).toBeUndefined();
  expect(actor).toHaveBeenCalledTimes(1);
});

it("keeps the frozen upload bytes when the original cold CLI regenerates its own host", async () => {
  const { root } = await setup();
  await NodeFSP.mkdir(NodePath.join(root, "host/generated"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(root, "node_modules"));
  await NodeFSP.writeFile(NodePath.join(root, "package.json"), '{"type":"module"}');
  await NodeFSP.writeFile(NodePath.join(root, "host/generated/worker.js"), "frozen upload bytes");
  await NodeFSP.writeFile(
    NodePath.join(root, "host/measure.ts"),
    `
    import * as fs from "node:fs/promises";
    await fs.writeFile(new URL("./generated/worker.js", import.meta.url), "regenerated");
    await fs.writeFile(process.argv[process.argv.indexOf("--output") + 1], JSON.stringify({called: 1}));
    process.exitCode = 1;
  `,
  );
  const output = NodePath.join(root, "cli-evidence.json");
  expect((await startCold(root, "https://fake.invalid", output, "fake-probe-secret")).exit).toBe(1);
  expect(await json(output)).toEqual({ called: 1 });
  expect(await NodeFSP.readFile(NodePath.join(root, "host/generated/worker.js"), "utf8")).toBe(
    "frozen upload bytes",
  );
});

it("runs five fresh controls sequentially, profiles each active root once, and preserves expected failures", async () => {
  const context = await setup();
  let running = false;
  let finish: (() => void) | undefined;
  const order: string[] = [];
  const dependencies: ControlDependencies = {
    cold: vi.fn(async (_root, _url, output) => {
      expect(running).toBe(false);
      running = true;
      order.push("cold");
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      await writeJson(output, cwdEvidence());
      running = false;
      return { exit: 1, stdout: "fake-probe-secret https://private.workers.dev", stderr: "" };
    }),
    profile: vi.fn(async (_cloud, _owner, _dir, _scratch, phase) => {
      expect(running).toBe(true);
      expect(phase).toBe("during-cold-request");
      order.push("profile");
      finish?.();
      return true;
    }),
    traffic: vi.fn(async () => {}),
  };
  const results = await runControls(
    context.cloud,
    context.root,
    [],
    "fake-probe-secret",
    context.output,
    context.root,
    context.ledger,
    dependencies,
  );
  expect(context.deploy).toHaveBeenCalledTimes(5);
  expect(new Set(results.map((r) => r.script)).size).toBe(5);
  expect(order).toEqual(Array.from({ length: 5 }, () => ["cold", "profile"]).flat());
  expect(dependencies.traffic).not.toHaveBeenCalled();
  expect(context.cleanup).toHaveBeenCalledTimes(5);
  expect(successfulControls(results)).toBe(true);
  expect(await json(NodePath.join(context.output, "summary.json"))).toMatchObject({
    controlsCompleted: 5,
    validColdOutcomes: 5,
    actualCwd44Count: 5,
    oomCount: 0,
  });
  const cold = await NodeFSP.readFile(NodePath.join(context.output, "control-1/cold.json"), "utf8");
  expect(cold).toContain("behavioral assertion failed");
  expect(cold).not.toContain("fake-probe-secret");
  expect(cold).not.toContain("private.workers.dev");
});

it("uses post-request root traffic only after an empty active lookup; OOM never becomes green", async () => {
  const context = await setup();
  let lookup = 0;
  vi.spyOn(context.cloud, "actor").mockImplementation(async (owner) => {
    if (++lookup % 2) return undefined;
    owner.actor = "a".repeat(64);
    return owner.actor;
  });
  let completed = false;
  const dependencies: ControlDependencies = {
    cold: vi.fn(async (_root, _url, output) => {
      await writeJson(output, {
        runId: "a".repeat(16),
        rows: [{ cold: true, path: "/startup", response: { error: "Memory limit exceeded" } }],
      });
      completed = true;
      return { exit: 1, stdout: "", stderr: "" };
    }),
    profile: vi.fn(async (_cloud, _owner, _dir, _scratch, phase) => {
      expect(completed).toBe(true);
      expect(phase).toBe("after-cold-request");
      return true;
    }),
    traffic: vi.fn(async (_url, session) => {
      expect(session).toBe(`${"a".repeat(16)}-1069-startup-r4-wasi-r4`);
    }),
  };
  const results = await runControls(
    context.cloud,
    context.root,
    [],
    "fake-probe-secret",
    context.output,
    context.root,
    context.ledger,
    dependencies,
  );
  expect(dependencies.cold).toHaveBeenCalledTimes(5);
  expect(dependencies.profile).toHaveBeenCalledTimes(5);
  expect(dependencies.traffic).toHaveBeenCalledTimes(5);
  expect(successfulControls(results)).toBe(false);
  expect(await json(NodePath.join(context.output, "summary.json"))).toMatchObject({
    oomCount: 5,
    oomFrequency: 1,
  });
});

it("continues all five controls and cleans every partial deployment on failures", async () => {
  const context = await setup();
  context.deploy.mockRejectedValue(new Error("upload response lost"));
  const dependencies: ControlDependencies = { cold: vi.fn(), profile: vi.fn(), traffic: vi.fn() };
  const results = await runControls(
    context.cloud,
    context.root,
    [],
    "fake-probe-secret",
    context.output,
    context.root,
    context.ledger,
    dependencies,
  );
  expect(results).toHaveLength(5);
  expect(context.cleanup).toHaveBeenCalledTimes(5);
  expect(dependencies.cold).not.toHaveBeenCalled();
  expect(successfulControls(results)).toBe(false);
  expect(await json(context.ledger)).toHaveLength(5);
});

it("cleans up after a profile exception and still finishes every cold request", async () => {
  const context = await setup();
  const dependencies: ControlDependencies = {
    cold: vi.fn(async (_root, _url, output) => {
      await writeJson(output, cwdEvidence());
      return { exit: 1, stdout: "", stderr: "" };
    }),
    profile: vi.fn(async () => {
      throw new Error("curl spawn failed");
    }),
    traffic: vi.fn(),
  };
  const results = await runControls(
    context.cloud,
    context.root,
    [],
    "fake-probe-secret",
    context.output,
    context.root,
    context.ledger,
    dependencies,
  );
  expect(dependencies.cold).toHaveBeenCalledTimes(5);
  expect(context.cleanup).toHaveBeenCalledTimes(5);
  expect(results.every((r) => r.classification === "cwd44")).toBe(true);
  expect(successfulControls(results)).toBe(false);
  expect(await json(NodePath.join(context.output, "control-1/profile-error.json"))).toMatchObject({
    httpStatus: null,
    error: "Error: curl spawn failed",
  });
});
