// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off - Real Workerd runs the built qualifier Worker behind its proof routes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { syntheticQualifierBuild } from "./claudeThreadRoute.fixture.ts";

let build: Awaited<ReturnType<typeof syntheticQualifierBuild>> | undefined;
let child: NodeChildProcess.ChildProcess | undefined;
let origin: string;
let runId: string;
let log = "";

/** The test's own Worker: the proof's front door, a gate on one seed read, and a command caller. */
const HARNESS =
  'import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";\n// The thread step reads this program seed while its product host seeds the kernel.\nconst GATED = "/qualifier/seed/bash";\nconst CHILD = `import { WorkerEntrypoint } from "cloudflare:workers";\nexport class Child extends WorkerEntrypoint {\n  run() { return { exitCode: 0, signal: 0, coreDumped: false }; }\n}`;\nexport class Gate extends DurableObject {\n  #blocked = Promise.withResolvers();\n  #released = Promise.withResolvers();\n  async wait() {\n    this.#blocked.resolve();\n    await this.#released.promise;\n  }\n  async blocked() {\n    await this.#blocked.promise;\n    return true;\n  }\n  release() {\n    this.#released.resolve();\n    return true;\n  }\n}\nexport class Assets extends WorkerEntrypoint {\n  async fetch(request) {\n    if (new URL(request.url).pathname === GATED) await this.env.GATE.getByName("gate").wait();\n    return this.env.DISK.fetch(request);\n  }\n}\nclass Target extends RpcTarget {\n  stopped() {}\n}\nexport default {\n  async fetch(request, env) {\n    const path = new URL(request.url).pathname;\n    if (path === "/gate/blocked") return Response.json(await env.GATE.getByName("gate").blocked());\n    if (path === "/gate/release") return Response.json(await env.GATE.getByName("gate").release());\n    if (path === "/command") {\n      const command = { executable: "/bin/rg", argv: ["rg", "needle", "/workspace"], cwd: "/workspace", env: {} };\n      const invocation = { loaderId: "thread-rg", mainModule: "main.js", entrypoint: "Child", modules: { "main.js": { js: CHILD } }, command };\n      return Response.json(await env.COMMANDS.run(invocation, new Target()));\n    }\n    return env.QUALIFIER.getByName(env.RUN_ID).fetch(request);\n  },\n};\n';

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });

async function call(method: "GET" | "POST", path: string) {
  for (let tries = 0; ; tries++) {
    try {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: { "x-qualifier-run": runId },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${response.status} ${text}`);
      return JSON.parse(text);
    } catch (cause) {
      // Only the first request waits for Workerd to listen.
      if (tries > 150 || path !== "/ready")
        throw new Error(`${method} ${path} failed: ${log.slice(-3000)}`, { cause });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

beforeAll(async () => {
  build = await syntheticQualifierBuild();
  const { output, configSha256 } = build;
  runId = build.runId;
  const objects = NodePath.join(output, "objects");
  await NodeFSP.mkdir(objects);
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  const namespaces = [
    ["QUALIFIER", "QualifierProof"],
    ["CLAUDE_FIXTURES", "QualifierClaudeFixtures"],
    ["HARNESS_RUN_STORE", "QualifierRunStore"],
    ["HARNESS_FILES_STORE", "QualifierFilesStore"],
    ["HARNESS_THREAD_SUPERVISOR", "QualifierSupervisor"],
    ["PLACEMENT_STORES", "QualifierPlacementStore"],
    ["PROCESS_EXECUTION_SHARDS", "QualifierShard"],
    ["CLAUDE_THREADS", "QualifierClaudeThread"],
    ["CLAUDE_USERS", "QualifierClaudeUser"],
    ["CLAUDE_POOLS", "QualifierClaudePool"],
  ] as const;
  const text = (name: string, value: string) =>
    `(name = "${name}", text = ${JSON.stringify(value)})`;
  await NodeFSP.writeFile(NodePath.join(output, "harness.js"), HARNESS);
  await NodeFSP.writeFile(
    NodePath.join(output, "config.capnp"),
    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "qualifier", worker = .qualifier),
    (name = "harness", worker = .harness),
    (name = "assets", disk = (path = ${JSON.stringify(NodePath.join(output, "assets"))}, writable = false)),
    (name = "objects", disk = (path = ${JSON.stringify(objects)}, writable = true)),
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "harness")],
);
const qualifier :Workerd.Worker = (
  modules = [(name = "qualifier-worker.mjs", esModule = embed "qualifier-worker.mjs")],
  compatibilityDate = "2026-10-19",
  compatibilityFlags = ["nodejs_compat", "new_module_registry"],
  bindings = [
    ${text("RUN_ID", runId)},
    ${text("WORKER_NAME", build.workerName)},
    ${text("CONFIG_SHA256", configSha256)},
    ${text("RESIDENT_BYTE_LIMIT", String(104 * 1024 * 1024))},
    ${text("BUNDLE_SHA256", "b".repeat(64))},
    ${namespaces.map(([name, className]) => `(name = "${name}", durableObjectNamespace = "${className}")`).join(",\n    ")},
    (name = "LOADER", workerLoader = ()),
    # The harness holds the thread step open on one seed read; every other read is the disk's.
    (name = "PROGRAM_ASSETS", service = (name = "harness", entrypoint = "Assets")),
    (name = "QUALIFIER_COMMANDS", service = (name = "qualifier", entrypoint = "QualifierCommands")),
    (name = "QUALIFIER_TAIL", service = (name = "qualifier", entrypoint = "QualifierTail")),
  ],
  durableObjectNamespaces = [
    ${namespaces.map(([, className]) => `(className = "${className}", uniqueKey = "${className}", enableSql = true)`).join(",\n    ")},
  ],
  # Deployed qualifier classes are SQLite-backed; in-memory storage has no SQL.
  durableObjectStorage = (localDisk = "objects"),
);
const harness :Workerd.Worker = (
  modules = [(name = "harness.js", esModule = embed "harness.js")],
  compatibilityDate = "2026-10-19",
  bindings = [
    ${text("RUN_ID", runId)},
    (name = "QUALIFIER", durableObjectNamespace = (className = "QualifierProof", serviceName = "qualifier")),
    (name = "GATE", durableObjectNamespace = "Gate"),
    (name = "DISK", service = "assets"),
    (name = "COMMANDS", service = (name = "qualifier", entrypoint = "QualifierCommands")),
  ],
  durableObjectNamespaces = [(className = "Gate", uniqueKey = "claude-thread-route-gate")],
  durableObjectStorage = (inMemory = void),
);
`,
  );
  // Wrangler pins this Workerd; it exports the binary for the current platform.
  const fromWrangler = NodeModule.createRequire(
    NodeModule.createRequire(import.meta.url).resolve("wrangler/package.json"),
  );
  child = NodeChildProcess.spawn(
    fromWrangler("workerd").default as string,
    ["serve", "--experimental", NodePath.join(output, "config.capnp")],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout?.on("data", (data) => (log += data));
  child.stderr?.on("data", (data) => (log += data));
}, 180_000);

afterAll(async () => {
  child?.kill("SIGTERM");
  await build?.dispose();
});

/** Every message on a serialized failure's cause chain, including Effect cause arrays. */
function messages(value: unknown): string[] {
  if (Array.isArray(value))
    return value.flatMap((item) => messages(item?.error ?? item?.defect ?? item));
  if (value === null || typeof value !== "object") return [];
  const failure = value as {
    readonly message?: unknown;
    readonly cause?: unknown;
    readonly reasons?: unknown;
  };
  return [
    ...(typeof failure.message === "string" ? [failure.message] : []),
    ...messages(failure.cause),
    ...messages(failure.reasons),
  ];
}

it("runs the proof's Claude step on the product thread host through to its SDK owner", async () => {
  expect(await call("GET", "/ready")).toMatchObject({ status: "ready", runId });
  await call("POST", "/claude/observer-calibration");
  expect(await call("POST", "/claude/thread/dispatch")).toMatchObject({ claimed: true, runId });
  // While the step is held open, a Grep's ripgrep through the qualifier's commands binding is
  // admitted and observed under the thread step's route.
  expect(await call("GET", "/gate/blocked")).toBe(true);
  expect(await call("POST", "/command")).toEqual({ exitCode: 0, signal: 0, coreDumped: false });
  const commandEvents = log
    .split("\n")
    .filter((line) => line.includes('"producerEvent"') && line.includes('"actual-command-run"'))
    .map((line) => JSON.parse(line.slice(line.indexOf("{"))).producerEvent);
  expect(commandEvents.map((event) => [event.milestone, event.route.path])).toEqual([
    ["entered", "/claude/thread/dispatch"],
    ["terminal", "/claude/thread/dispatch"],
  ]);
  await call("POST", "/gate/release");
  const receipt = await call("GET", "/claude/thread/receipt");
  expect(receipt, log.slice(-3000)).toMatchObject({
    schema: "signalbox/claude-qualification-thread/v1",
    runId,
    status: "failed",
    result: { completed: false, turns: [], model: { requests: 0, workCompleted: false } },
  });
  // The synthetic release has no official CLI. Its SDK refusing the query is the first step that
  // needs one: the thread host, its seeded kernel and its SDK owner all opened before it, and the
  // owners were the thread's own facets, or Workers would have refused them with DataCloneError.
  const chain = messages(receipt.result.failure);
  expect(chain).toContain("Claude Agent SDK query failed.");
  expect(chain.at(-1)).toBe("Synthetic SDK cannot start an official Claude process");
  expect(chain.join("\n")).not.toMatch(/DataCloneError|not serializable/u);
  // The step is claimed once; a second dispatch never replays native work.
  await expect(call("POST", "/claude/thread/dispatch")).rejects.toThrow();
}, 180_000);
