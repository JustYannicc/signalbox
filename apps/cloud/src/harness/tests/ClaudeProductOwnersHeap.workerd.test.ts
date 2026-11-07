// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off - Real Workerd measures the provisioning isolate's heap through its inspector.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { build } from "esbuild";

const MiB = 1024 * 1024;
// About the size of the official CLI's release source (release.js plus worker-hooks.js).
const SYNTHETIC_CLI_MIB = 49;
// SIGNALBOX_CLAUDE_CLI_MODULES_DIR may name a real CLI release: manifest.json lists
// { name, type } module entries, each stored at its name under the directory.
const realModules = NodeProcess.env.SIGNALBOX_CLAUDE_CLI_MODULES_DIR;

let directory: string;
let child: NodeChildProcess.ChildProcess | undefined;
let origin: string;
let inspector: string;
let log = "";

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });

async function retry<T>(attempt: () => Promise<T>) {
  for (let tries = 0; ; tries++) {
    try {
      return await attempt();
    } catch (cause) {
      if (tries > 150) throw new Error(`Workerd did not start: ${log.slice(-2000)}`, { cause });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/** The provisioning Worker's own isolate, read after the fixture forced a full GC in it. */
async function provisioningHeap() {
  const targets: Array<{ title: string; webSocketDebuggerUrl: string }> = await (
    await fetch(`${inspector}/json`)
  ).json();
  const target = targets.find((candidate) => candidate.title === "workerd: worker main");
  if (target === undefined)
    throw new Error(`No provisioning isolate in ${JSON.stringify(targets)}`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const reply = new Promise<{ result?: { usedSize: number }; error?: unknown }>((resolve) => {
    socket.addEventListener("message", (message) => {
      const value = JSON.parse(String(message.data));
      if (value.id === 1) resolve(value);
    });
  });
  socket.send(JSON.stringify({ id: 1, method: "Runtime.getHeapUsage" }));
  const answer = await reply;
  socket.close();
  if (answer.result === undefined) throw new Error(`No heap usage: ${JSON.stringify(answer)}`);
  const usage = answer.result;
  return { usedSize: usage.usedSize, owners: targets.map((candidate) => candidate.title) };
}

beforeAll(async () => {
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-owner-heap-"));
  const bundled = await build({
    entryPoints: [
      NodeURL.fileURLToPath(new URL("./productHost/ownerHeap.workerd.fixture.ts", import.meta.url)),
    ],
    bundle: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd", "worker", "browser"],
    target: "esnext",
    external: ["cloudflare:workers", "node:*"],
    write: false,
  });
  await NodeFSP.writeFile(NodePath.join(directory, "worker.js"), bundled.outputFiles[0]!.text);
  let modules = realModules;
  if (modules === undefined) {
    modules = NodePath.join(directory, "modules");
    await NodeFSP.mkdir(NodePath.join(modules, "cli"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(modules, "manifest.json"),
      JSON.stringify([{ name: "cli/release.js", type: "js" }]),
    );
    await NodeFSP.writeFile(
      NodePath.join(modules, "cli/release.js"),
      `export const release = true;\n//${"x".repeat(SYNTHETIC_CLI_MIB * MiB)}`,
    );
  }
  const [port, inspectorPort] = [await freePort(), await freePort()];
  origin = `http://127.0.0.1:${port}`;
  inspector = `http://127.0.0.1:${inspectorPort}`;
  await NodeFSP.writeFile(
    NodePath.join(directory, "config.capnp"),
    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  v8Flags = ["--expose-gc"],
  services = [
    (name = "main", worker = .main),
    (name = "modules", disk = (path = ${JSON.stringify(modules)}, writable = false)),
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
);
const main :Workerd.Worker = (
  modules = [(name = "worker.js", esModule = embed "worker.js")],
  compatibilityDate = "2026-10-19",
  bindings = [
    (name = "PROBE", durableObjectNamespace = "OwnerHeapProbe"),
    (name = "LOADER", workerLoader = ()),
    (name = "MODULES", service = "modules"),
  ],
  durableObjectNamespaces = [(className = "OwnerHeapProbe", uniqueKey = "owner-heap-probe")],
  durableObjectStorage = (inMemory = void),
);
`,
  );
  // Wrangler pins this Workerd; it exports the binary for the current platform.
  const fromWrangler = NodeModule.createRequire(
    NodeModule.createRequire(import.meta.url).resolve("wrangler/package.json"),
  );
  const workerd: string = fromWrangler("workerd").default;
  child = NodeChildProcess.spawn(
    workerd,
    [
      "serve",
      "--experimental",
      NodePath.join(directory, "config.capnp"),
      `--inspector-addr=127.0.0.1:${inspectorPort}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout?.on("data", (data) => (log += data));
  child.stderr?.on("data", (data) => (log += data));
  await retry(() => fetch(`${inspector}/json`).then((response) => response.json()));
}, 120_000);

afterAll(async () => {
  child?.kill("SIGTERM");
  if (directory !== undefined) await NodeFSP.rm(directory, { recursive: true, force: true });
});

it("provisions every owner without its parent keeping the CLI's code, and loads each once", async () => {
  const response = await retry(async () => {
    const result = await fetch(`${origin}/provision`);
    if (!result.ok) throw new Error(`${result.status} ${await result.text()}`);
    return result;
  });
  const provisioned: {
    calls: Record<string, number>;
    pinged: string[];
    collected: boolean;
  } = await response.json();
  expect(provisioned.collected).toBe(true);
  expect(provisioned.pinged).toEqual([
    "kernel",
    "cli",
    "computer",
    "sdk",
    "kernel",
    "cli",
    "computer",
    "sdk",
  ]);
  // A second provision of live owners reuses each loaded Worker; no factory runs twice.
  expect(provisioned.calls).toEqual({ kernel: 1, cli: 1, computer: 1, sdk: 1 });
  const heap = await provisioningHeap();
  expect(heap.owners.some((title) => title.includes("heap-probe:cli"))).toBe(true);
  // The CLI owner alone loaded ~49 MiB; the provisioning thread keeps none of it.
  expect(heap.usedSize).toBeLessThan(40 * MiB);
  await fetch(`${origin}/retire`);
}, 120_000);
