// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off - Real Workerd measures the facet's heap through its inspector.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { build } from "esbuild";

const MiB = 1024 * 1024;
// A deployed qualifier's asset directory: qualifier/config.json plus the Claude release it pins.
const assets = NodeProcess.env.SIGNALBOX_QUALIFIER_ASSETS_DIR;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });

describe.skipIf(assets === undefined)("Claude facet setup heap", () => {
  it("reads its configuration without parsing the qualifier file, and stays small", async () => {
    if (assets === undefined) throw new Error("Qualifier assets are required");
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-facet-heap-"));
    let child: NodeChildProcess.ChildProcess | undefined;
    let log = "";
    try {
      const bundled = await build({
        entryPoints: [
          NodeURL.fileURLToPath(new URL("./claudeFacetSetup.workerd.fixture.ts", import.meta.url)),
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
      const bytes = await NodeFSP.readFile(NodePath.join(assets, "qualifier/config.json"));
      const config = JSON.parse(bytes.toString("utf8"));
      const json = (value: unknown) => JSON.stringify(JSON.stringify(value));
      const [port, inspectorPort] = [await freePort(), await freePort()];
      await NodeFSP.writeFile(
        NodePath.join(directory, "config.capnp"),
        `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  v8Flags = ["--expose-gc"],
  services = [
    (name = "main", worker = .main),
    (name = "assets", disk = (path = ${JSON.stringify(assets)}, writable = false)),
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
);
const main :Workerd.Worker = (
  modules = [(name = "worker.js", esModule = embed "worker.js")],
  compatibilityDate = "2026-10-19",
  bindings = [
    (name = "PROBE", durableObjectNamespace = "ClaudeFacetSetupProbe"),
    (name = "PROGRAM_ASSETS", service = "assets"),
    (name = "RUN_ID", text = ${JSON.stringify(config.runId)}),
    (name = "CONFIG_SHA256", text = "${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}"),
    (name = "QUALIFIER_CLAUDE_VARIANT", text = "baseline"),
    (name = "QUALIFIER_CLAUDE_PROCESS_ENVIRONMENT", json = ${json({})}),
    (name = "QUALIFIER_CLAUDE_RUNTIME", json = ${json(config.claude.runtime)}),
    (name = "SELECTED_ARTIFACT", json = ${json(config.claude.expected.baseline.artifact)}),
  ],
  durableObjectNamespaces = [(className = "ClaudeFacetSetupProbe", uniqueKey = "claude-facet-setup")],
  durableObjectStorage = (inMemory = void),
);
`,
      );
      const fromWrangler = NodeModule.createRequire(
        NodeModule.createRequire(import.meta.url).resolve("wrangler/package.json"),
      );
      child = NodeChildProcess.spawn(
        fromWrangler("workerd").default as string,
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
      const retry = async <T>(attempt: () => Promise<T>) => {
        for (let tries = 0; ; tries++) {
          try {
            return await attempt();
          } catch (cause) {
            if (tries > 150) throw new Error(`Workerd failed: ${log.slice(-2000)}`, { cause });
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
      };
      const get = (path: string) =>
        retry(async () => {
          const response = await fetch(`http://127.0.0.1:${port}${path}`);
          if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
          return response.json();
        });
      const heap = async () => {
        const targets: Array<{ title: string; webSocketDebuggerUrl: string }> = await (
          await fetch(`http://127.0.0.1:${inspectorPort}/json`)
        ).json();
        const target = targets.find((candidate) => candidate.title === "workerd: worker main")!;
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          socket.addEventListener("open", resolve, { once: true });
          socket.addEventListener("error", reject, { once: true });
        });
        const reply = new Promise<{ result: { usedSize: number } }>((resolve) => {
          socket.addEventListener("message", (message) => {
            const value = JSON.parse(String(message.data));
            if (value.id === 1) resolve(value);
          });
        });
        socket.send(JSON.stringify({ id: 1, method: "Runtime.getHeapUsage" }));
        const used = (await reply).result.usedSize;
        socket.close();
        return used;
      };
      await get("/ready");
      const sampling = new AbortController();
      let peak = 0;
      const sampler = (async () => {
        while (!sampling.signal.aborted) peak = Math.max(peak, await heap());
      })();
      const result = await get("/setup");
      sampling.abort();
      await sampler;
      expect(result).toEqual({ collected: true, releaseLoaded: true });
      // Two parses of the 14.6 MB qualifier file once pushed this past 110 MiB, garbage included.
      expect(peak).toBeLessThan(40 * MiB);
      expect(await heap()).toBeLessThan(40 * MiB);
    } finally {
      child?.kill("SIGTERM");
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  }, 240_000);
});
