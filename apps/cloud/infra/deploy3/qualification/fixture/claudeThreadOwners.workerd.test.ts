// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off - Real Workerd enforces which stubs may cross a Worker boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { build } from "esbuild";

let directory: string;
let child: NodeChildProcess.ChildProcess | undefined;
let origin: string;
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

interface Realm {
  readonly realm: string;
  readonly env: readonly string[];
}
type Roles<A> = Record<"kernel" | "cli" | "computer" | "sdk", A>;
interface Provisioned {
  readonly host: string;
  readonly owners: Roles<Realm>;
  readonly kernelPeer: string;
  readonly calls: Roles<number>;
  readonly tails: Roles<number>;
}
interface Crossing {
  readonly refused: boolean;
  readonly name?: string;
  readonly message?: string;
}

const get = async <A>(path: string): Promise<A> => {
  for (let tries = 0; ; tries++) {
    try {
      const response = await fetch(`${origin}${path}`);
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      return (await response.json()) as A;
    } catch (cause) {
      if (tries > 150) throw new Error(`Workerd failed: ${log.slice(-2000)}`, { cause });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
};

beforeAll(async () => {
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-thread-owners-"));
  const bundled = await build({
    entryPoints: [
      NodeURL.fileURLToPath(new URL("./claudeThreadOwners.workerd.fixture.ts", import.meta.url)),
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
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  await NodeFSP.writeFile(
    NodePath.join(directory, "config.capnp"),
    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "main", worker = .main)],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
);
const main :Workerd.Worker = (
  modules = [(name = "worker.js", esModule = embed "worker.js")],
  compatibilityDate = "2026-10-19",
  compatibilityFlags = ["nodejs_compat"],
  bindings = [
    (name = "LOADER", workerLoader = ()),
    (name = "HOST", durableObjectNamespace = "ClaudeThreadOwnersHost"),
    (name = "PEER", durableObjectNamespace = "OwnerPeer"),
    (name = "COMMANDS", service = (name = "main", entrypoint = "OwnerCommands")),
    (name = "TAIL", service = (name = "main", entrypoint = "OwnerTail")),
  ],
  durableObjectNamespaces = [
    (className = "ClaudeThreadOwnersHost", uniqueKey = "claude-thread-owners-host"),
    (className = "OwnerPeer", uniqueKey = "claude-thread-owner-peer"),
  ],
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
    ["serve", "--experimental", NodePath.join(directory, "config.capnp")],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout?.on("data", (data) => (log += data));
  child.stderr?.on("data", (data) => (log += data));
}, 120_000);

afterAll(async () => {
  child?.kill("SIGTERM");
  if (directory !== undefined) await NodeFSP.rm(directory, { recursive: true, force: true });
});

it("opens every owner as the Claude host's own facet, each in its own isolate with its tail", async () => {
  const provisioned = await get<Provisioned>("/provision");
  const owners = [
    provisioned.owners.kernel.realm,
    provisioned.owners.cli.realm,
    provisioned.owners.computer.realm,
    provisioned.owners.sdk.realm,
  ];
  expect(new Set([provisioned.host, ...owners]).size).toBe(5);
  // Each owner received only serializable capabilities: a namespace stub and service bindings.
  expect(provisioned.owners.kernel.env).toEqual(["PEER"]);
  expect(provisioned.kernelPeer).toBe("peer");
  expect(provisioned.owners.computer.env).toEqual(["CHILD_WORKERS", "RESIDENT_BYTE_LIMIT"]);
  expect(provisioned.owners.sdk.env).toEqual(["CLAUDE_SDK_PLAN", "CLAUDE_SDK_RELEASE"]);
  expect(provisioned.calls).toEqual({ kernel: 1, cli: 1, computer: 1, sdk: 1 });
  expect(provisioned.tails).toEqual({ kernel: 1, cli: 1, computer: 1, sdk: 1 });
}, 120_000);

it("is refused by the platform when owner facet stubs are handed to another Worker", async () => {
  const crossing = await get<Crossing>("/crossing");
  expect(crossing).toMatchObject({ refused: true, name: "DataCloneError" });
  expect(crossing.message).toMatch(/facet/i);
}, 120_000);
