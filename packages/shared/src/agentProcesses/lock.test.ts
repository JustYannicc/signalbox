// @effect-diagnostics nodeBuiltinImport:off - Tests recovery across real Node subprocesses.
import { expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "../HostProcess.ts";

const platform = HostProcess.Platform.defaultValue();

const workerSource = String.raw`
import * as fs from "node:fs";
import * as path from "node:path";
import { withRegistryLock } from ${JSON.stringify(new URL("./lock.ts", import.meta.url).href)};

const commonDir = process.env.SIGNALBOX_TEST_COMMON_DIR;
if (commonDir === undefined) throw new Error("missing common dir");
const platform = process.env.SIGNALBOX_TEST_PLATFORM;
if (platform === undefined) throw new Error("missing test platform");
const identity = { platform, bootId: "test-boot", startTime: String(process.pid) };
const processOps = {
  identify: async (pid) => pid === process.pid ? identity : undefined,
  inspect: async (pid) => {
    if (pid === 4000000000) return { state: "missing" };
    try {
      process.kill(pid, 0);
      return { state: "running", identity: { ...identity, startTime: String(pid) }, cwd: process.cwd() };
    } catch (error) {
      if (error.code === "EPERM") return { state: "running", identity: { ...identity, startTime: String(pid) }, cwd: process.cwd() };
      return error.code === "ESRCH" ? { state: "missing" } : { state: "unknown", reason: "inaccessible" };
    }
  },
  metrics: async () => new Map(),
  sendSignal: () => { throw new Error("not used"); },
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
const marker = path.join(commonDir, "active-callback");
await withRegistryLock({ commonDir, processOps, run: async () => {
  const descriptor = fs.openSync(marker, "wx", 0o600);
  fs.closeSync(descriptor);
  await new Promise((resolve) => setTimeout(resolve, 50));
  fs.rmSync(marker, { force: true });
} });
`;

it("serializes concurrent stale-lock recovery without removing a successor lock", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "signalbox-registry-lock-"));
  const commonDir = NodePath.join(root, "repo.git");
  const lockDirectory = NodePath.join(commonDir, "signalbox-agent-processes");
  const lockPath = NodePath.join(lockDirectory, "registry.lock");
  NodeFS.mkdirSync(lockDirectory, { recursive: true });
  NodeFS.writeFileSync(
    lockPath,
    JSON.stringify({
      token: "dead-owner",
      pid: 4_000_000_000,
      identity: { platform, bootId: "test-boot", startTime: "old" },
    }),
  );

  const workers = [1, 2].map(() =>
    NodeChildProcess.spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", workerSource],
      {
        env: {
          ...process.env,
          SIGNALBOX_TEST_COMMON_DIR: commonDir,
          SIGNALBOX_TEST_PLATFORM: platform,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  try {
    const outputs = await Promise.all(
      workers.map(async (worker) => {
        let output = "";
        worker.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          output += chunk;
        });
        worker.stderr.setEncoding("utf8").on("data", (chunk: string) => {
          output += chunk;
        });
        const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(
          (resolve) =>
            worker.once("exit", (exitCode, exitSignal) => resolve([exitCode, exitSignal])),
        );
        return { code, signal, output };
      }),
    );

    expect(outputs).toEqual([
      expect.objectContaining({ code: 0, signal: null }),
      expect.objectContaining({ code: 0, signal: null }),
    ]);
    expect(NodeFS.existsSync(lockPath)).toBe(false);
    expect(NodeFS.existsSync(`${lockPath}.recovery`)).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(commonDir, "active-callback"))).toBe(false);
  } finally {
    for (const worker of workers) {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
    }
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
