// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalDate:off - isolated diagnostic host without an Effect runtime.
import { DurableObject } from "cloudflare:workers";
import { createFacetFilePersistence } from "../../src/kernel/FacetFilePersistence.ts";
import { createMemoryFilePersistencePorts } from "../../src/kernel/MemoryFilePersistencePorts.ts";
import { KernelWakeRegistry } from "../../src/kernel/KernelWakeRegistry.ts";
import { KernelFileSystem } from "../../src/kernel/KernelFileSystem.ts";
import { createNodeFs } from "../../src/isolate/NodeFs.ts";
import { createNodeProcess } from "../../src/isolate/NodeProcess.ts";
import { createNodePath } from "../../src/isolate/NodePath.ts";
import { createNodeOs } from "../../src/isolate/NodeOs.ts";
import { createNodeModule } from "../../src/isolate/NodeModule.ts";
import { bootNodeRelease } from "../../src/isolate/NodeBootstrap.ts";
import type { NodeBridge } from "../../src/isolate/NodeBridge.ts";
import { createBunShim } from "../../src/isolate/BunShim.ts";
import { decodeVerifiedAssetBundle } from "./assetBundle.ts";
import { createMockMessagesApi } from "./mockMessages.ts";
import { getNativeHostModules } from "./proofNativeModules.ts";
import { createGuestObservation, errorDetail, readAssetBody } from "./proofObservation.ts";
import {
  proofPrompt,
  seedToolScenario,
  terminalSuccess,
  verifyCommittedToolScenario,
  type ProofScenario,
  type ContextTokenEquivalent,
} from "./proofScenario.ts";
import { TOOL_SCENARIO } from "./toolScenario.ts";
import { verifySeededAssets } from "./proofAssets.ts";

export interface ClaudeTurnProofConfig {
  readonly assets: Readonly<Record<string, { bytes: number; sha256: string }>>;
  readonly pins: Readonly<Record<string, unknown>>;
  readonly requireSeed: boolean;
  readonly assetsOnly?: boolean;
  readonly scenario: ProofScenario;
  readonly contextTokenEquivalent?: ContextTokenEquivalent;
  readonly loadRelease: () => Promise<unknown>;
}

export function createClaudeTurnProofClass(
  config: ClaudeTurnProofConfig,
): new (ctx: DurableObjectState, env: Cloudflare.Env) => DurableObject {
  return class ClaudeTurnProof extends DurableObject {
    private filesystemHost: ReturnType<typeof createFilesystemHost> | undefined;
    private bootStarted = false;
    private assetsSeeded = false;

    private filesystem() {
      return (this.filesystemHost ??= createFilesystemHost(this.ctx.storage));
    }

    override async fetch(request: Request) {
      try {
        const path = new URL(request.url).pathname;
        if (path === "/seed-assets") return await this.seedAssets(request);
        if (path === "/verify-assets") {
          if (request.method !== "GET") return new Response("GET required", { status: 405 });
          if (!this.assetsSeeded) throw new Error("ERR_DIAGNOSTIC_ASSETS_NOT_SEEDED");
          return Response.json(await verifySeededAssets(this.filesystem().fs, config.assets));
        }
        if (config.assetsOnly) return new Response("Asset verification only", { status: 404 });
        if (path !== "/boot")
          return Response.json({ ok: false, error: "Unknown proof endpoint" }, { status: 404 });
        if (config.requireSeed && !this.assetsSeeded)
          throw new Error("ERR_DIAGNOSTIC_ASSETS_NOT_SEEDED");
        if (this.bootStarted) throw new Error("ERR_DIAGNOSTIC_BOOT_ALREADY_STARTED");
        this.bootStarted = true;
        return await this.boot();
      } catch (error) {
        return Response.json({
          ok: false,
          phase: "host-error",
          error: errorDetail(error),
          pins: config.pins,
        });
      }
    }

    private async seedAssets(request: Request) {
      if (request.method !== "POST") return new Response("POST required", { status: 405 });
      if (request.headers.get("content-type") !== "application/vnd.signalbox.claude-assets.v1") {
        return new Response("Wrong asset bundle content type", { status: 415 });
      }
      if (this.bootStarted || this.assetsSeeded) throw new Error("ERR_DIAGNOSTIC_ASSET_SEED_ORDER");
      const entries = await decodeVerifiedAssetBundle(await readAssetBody(request), config.assets);
      const { fs } = this.filesystem();
      this.ctx.storage.transactionSync(() => {
        for (const entry of entries) {
          fs.fs.mkdirSync(entry.path.slice(0, entry.path.lastIndexOf("/")), { recursive: true });
          fs.fs.writeFileSync(entry.path, entry.bytes);
        }
      });
      this.assetsSeeded = true;
      return Response.json({
        ok: true,
        seededAssets: entries.length,
        seededBytes: entries.reduce((sum, entry) => sum + entry.bytes.byteLength, 0),
      });
    }

    private async boot() {
      const observation = createGuestObservation();
      const { output, done, complete, guestError, streams } = observation;
      try {
        const mock = createMockMessagesApi({
          bootText: "mock",
          finalText: "mock",
          recordRequestBodies: config.contextTokenEquivalent === undefined,
          ...(config.scenario === "tools" ? { tools: TOOL_SCENARIO } : {}),
        });
        globalThis.fetch = mock.fetch;
        const filesystemHost = this.filesystem();
        const { filesystem, fs } = filesystemHost;
        if (config.scenario === "tools") seedToolScenario(filesystemHost);
        const env = proofEnvironment();
        const prompt = proofPrompt(config.scenario, config.contextTokenEquivalent);
        const identity = proofIdentity(prompt.text);
        const host = {
          filesystem: {
            get cwd() {
              try {
                return filesystem.cwd;
              } catch (error) {
                output.errors.push({ operation: "host-filesystem.cwd", ...errorDetail(error) });
                throw error;
              }
            },
            chdir: (directory: string) => filesystem.chdir(directory),
          },
          env,
          identity,
          streams,
        };
        const process = createNodeProcess(host);
        process.on("exit", (code: number) => {
          output.exitCode = code;
          complete("process-exit");
        });
        let bridge: NodeBridge;
        const module = createNodeModule({ require: (specifier) => bridge.require(specifier) });
        const path = createNodePath(filesystem);
        const { bun } = createBunShim({
          env,
          main: "/$bunfs/root/cli",
          version: "1.3.11",
          files: {
            readFile: async (target) => {
              if (
                typeof target === "string" &&
                Object.hasOwn(config.assets, target) &&
                !this.assetsSeeded
              ) {
                throw Object.assign(new Error(`Diagnostic asset bytes not seeded: ${target}`), {
                  code: "ERR_DIAGNOSTIC_ASSET_UNSEEDED",
                });
              }
              const bytes = fs.fs.readFileSync(target);
              return typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
            },
            writeFile: async (target, bytes) => {
              fs.fs.writeFileSync(target, bytes);
            },
            stat: async (target) =>
              typeof target === "number" ? fs.fs.fstatSync(target) : fs.fs.statSync(target),
            statSync: (target) =>
              typeof target === "number" ? fs.fs.fstatSync(target) : fs.fs.statSync(target),
          },
          onMissing: (member) => output.bunMissing.push(member),
        });
        const modules = {
          ...getNativeHostModules(),
          ...fs,
          process,
          os: createNodeOs(host),
          path,
          "path/posix": path.posix,
          "path/win32": path.win32,
          module,
        };
        output.milestones.push("host-ready");
        observation.startDeadline();
        try {
          await Promise.race([
            bootNodeRelease({ modules, globals: { Bun: bun, process } }, async (installed) => {
              bridge = installed;
              output.milestones.push("release-import-start");
              const release = await config.loadRelease();
              output.milestones.push("release-import-returned");
              if (
                !release ||
                typeof release !== "object" ||
                typeof Reflect.get(release, "launch") !== "function"
              )
                throw new Error("ERR_DIAGNOSTIC_RELEASE_LAUNCH_MISSING");
              output.milestones.push("release-launch-start");
              await Reflect.apply(Reflect.get(release, "launch"), release, []);
              output.milestones.push("release-launch-returned");
              return release;
            }),
            done,
          ]);
        } catch (error) {
          guestError("release-error", error);
        }
        await done;
        const scenarioResult =
          config.scenario === "tools"
            ? await verifyCommittedToolScenario(filesystemHost, output, mock)
            : undefined;
        return Response.json({
          ...output,
          scenario: config.scenario,
          prompt: { estimatedTokens: prompt.estimatedTokens, paddingBytes: prompt.paddingBytes },
          scenarioResult,
          pins: config.pins,
          assetsSeeded: this.assetsSeeded,
          ok: terminalSuccess(output) && (scenarioResult?.ok ?? mock.complete),
          mock: { requests: mock.requests, denied: mock.deniedRequests, complete: mock.complete },
          process: {
            same: Object.is(globalThis.process, process),
            cwd: process.cwd(),
            filesystemCwd: filesystem.cwd,
          },
          filesystem: { cwd: filesystem.cwd, workEntries: fs.fs.readdirSync("/work") },
        });
      } finally {
        observation.restore();
      }
    }
  };
}

function createFilesystemHost(storage: DurableObjectStorage) {
  const wakes = new KernelWakeRegistry();
  const ports = createMemoryFilePersistencePorts();
  const persistence = createFacetFilePersistence(storage, () => BigInt(Date.now()) * 1_000_000n, {
    wakes,
    ports,
  });
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: persistence.storage }],
    cwd: "/",
  });
  const fs = createNodeFs(filesystem);
  for (const directory of ["/work", "/home/claude", "/tmp", "/usr/local/bin"])
    fs.fs.mkdirSync(directory, { recursive: true });
  filesystem.chdir("/work");
  return { wakes, ports, persistence, filesystem, fs };
}

function proofEnvironment() {
  return {
    HOME: "/home/claude",
    TMPDIR: "/tmp",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    TERM: "dumb",
    NO_COLOR: "1",
    ANTHROPIC_API_KEY: "mock-only-dummy-key",
    ANTHROPIC_BASE_URL: "http://mock.anthropic.invalid",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
    CI: "1",
    CLAUDE_CODE_SIMPLE: "1",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    http_proxy: "",
    https_proxy: "",
    all_proxy: "",
    NO_PROXY: "*",
    no_proxy: "*",
  };
}

function proofIdentity(prompt: string) {
  return {
    version: "v24.18.0",
    versions: { node: "24.18.0", bun: "1.3.11" },
    platform: "linux",
    arch: "x64",
    type: "Linux",
    endianness: "LE" as const,
    availableParallelism: 1,
    user: { username: "claude", uid: 1000, gid: 1000, shell: "/bin/bash" },
    homedir: "/home/claude",
    tmpdir: "/tmp",
    pid: 100,
    ppid: 1,
    execPath: "/usr/local/bin/claude",
    argv0: "claude",
    argv: [
      "claude",
      "/$bunfs/root/cli",
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--allowedTools",
      "Read,Edit,Write,Grep,Glob,Bash",
      "--bare",
    ],
  };
}
