// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalDate:off - isolated diagnostic host without an Effect runtime.
import { DurableObject } from "cloudflare:workers";
import { createProofFilesystemHost } from "./proofFilesystem.ts";
import { createProofProgramRuntime } from "./proofProgramRuntime.ts";
import type { ProofProgramModules } from "./proofPrograms.ts";
import { createNodePath } from "../../src/isolate/NodePath.ts";
import { createNodeOs } from "../../src/isolate/NodeOs.ts";
import * as NodeConstants from "node:constants";
import { createNodeConstants } from "../../src/isolate/NodeConstants.ts";
import {
  createProofEnvironment,
  createProofIdentity,
  createProofProcessEnvironment,
  type ProofPackages,
} from "./proofEnvironment.ts";
import { bootNodeRelease } from "../../src/isolate/NodeBootstrap.ts";
import type { NodeBridge } from "../../src/isolate/NodeBridge.ts";
import { decodeVerifiedAssetBundle } from "./assetBundle.ts";
import {
  createPreparedAssetModuleResolver,
  type PreparedAssetModuleCatalog,
} from "./preparedAssetModules.ts";
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
import {
  createProofExecutableSeedRoute,
  type ProofExecutableFileCatalog,
} from "./proofExecutableSeed.ts";

export interface ClaudeTurnProofConfig {
  readonly assets: PreparedAssetModuleCatalog;
  readonly pins: Readonly<Record<string, unknown>>;
  readonly requireSeed: boolean;
  readonly assetsOnly?: boolean;
  readonly packagesOnly?: boolean;
  readonly loadPackages: () => Promise<ProofPackages>;
  readonly scenario: ProofScenario;
  readonly contextTokenEquivalent?: ContextTokenEquivalent;
  readonly loadRelease: () => Promise<unknown>;
  readonly programs?: ProofProgramModules;
  readonly programFiles?: ProofExecutableFileCatalog;
}

export function createClaudeTurnProofClass(
  config: ClaudeTurnProofConfig,
): new (ctx: DurableObjectState, env: Cloudflare.Env) => DurableObject {
  if ((config.programs === undefined) !== (config.programFiles === undefined)) {
    throw new Error("Proof executable modules and seeded file catalog must be configured together");
  }
  return class ClaudeTurnProof extends DurableObject {
    private filesystemHost: ReturnType<typeof createProofFilesystemHost> | undefined;
    private programSeedRoute: ReturnType<typeof createProofExecutableSeedRoute> | undefined;
    private bootStarted = false;
    private assetsSeeded = false;

    private filesystem() {
      return (this.filesystemHost ??= createProofFilesystemHost(this.ctx.storage));
    }

    override async fetch(request: Request) {
      try {
        const path = new URL(request.url).pathname;
        if (path === "/seed-assets") return await this.seedAssets(request);
        if (path === "/seed-programs") return await this.seedPrograms(request);
        if (path === "/verify-assets") {
          if (request.method !== "GET") return new Response("GET required", { status: 405 });
          if (!this.assetsSeeded) throw new Error("ERR_DIAGNOSTIC_ASSETS_NOT_SEEDED");
          return Response.json(await verifySeededAssets(this.filesystem().fs, config.assets));
        }
        if (config.assetsOnly) return new Response("Asset verification only", { status: 404 });
        if (path !== (config.packagesOnly ? "/verify-packages" : "/boot"))
          return Response.json({ ok: false, error: "Unknown proof endpoint" }, { status: 404 });
        if (config.requireSeed && !this.assetsSeeded)
          throw new Error("ERR_DIAGNOSTIC_ASSETS_NOT_SEEDED");
        if (config.programFiles !== undefined && !this.programSeedHandler().seeded)
          throw new Error("ERR_DIAGNOSTIC_PROGRAMS_NOT_SEEDED");
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

    private programSeedHandler() {
      const catalog = config.programFiles;
      if (catalog === undefined) throw new Error("ERR_DIAGNOSTIC_PROGRAMS_NOT_CONFIGURED");
      return (this.programSeedRoute ??= createProofExecutableSeedRoute({
        catalog,
        filesystem: () => this.filesystem().filesystem,
        storage: this.ctx.storage,
      }));
    }

    private async seedPrograms(request: Request) {
      if (config.programFiles === undefined) {
        return new Response("Program seeding is not configured", { status: 404 });
      }
      return await this.programSeedHandler().handle(request, {
        bootStarted: this.bootStarted,
        assetsRequired: config.requireSeed,
        assetsSeeded: this.assetsSeeded,
      });
    }

    private async boot() {
      const observation = createGuestObservation();
      const { output, done, complete, guestError, streams } = observation;
      let cpuRoot: ReturnType<typeof createProofProgramRuntime>["cpuRoot"] | undefined;
      let leaveCpuUser: (() => void) | undefined;
      const stopCpuAccounting = () => {
        leaveCpuUser?.();
        leaveCpuUser = undefined;
        cpuRoot?.stop();
        cpuRoot = undefined;
      };
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
        const env = createProofProcessEnvironment();
        const prompt = proofPrompt(config.scenario, config.contextTokenEquivalent);
        const identity = createProofIdentity(prompt.text);
        const runtime = createProofProgramRuntime({
          ...filesystemHost,
          ...(config.programs === undefined ? {} : { modules: config.programs }),
          env,
          identity,
          streams,
          assets: config.assets,
          isSeeded: () => this.assetsSeeded,
          onMissing: (member) => output.bunMissing.push(member),
        });
        const { process, childProcess, bun } = runtime;
        cpuRoot = runtime.cpuRoot;
        process.on("exit", (code: number) => {
          output.exitCode = code;
          complete("process-exit");
        });
        let bridge: NodeBridge;
        const environment = createProofEnvironment({
          bridge: () => bridge,
          loadPackages: config.loadPackages,
          onBuiltinFailure: (specifier) => output.builtinMissing.push(specifier),
          prepared: createPreparedAssetModuleResolver({
            assets: config.assets,
            fs,
            isSeeded: () => this.assetsSeeded,
          }),
        });
        let packageLoad: Awaited<ReturnType<typeof environment.load>> | undefined;
        const path = createNodePath(filesystem);
        const modules = {
          ...getNativeHostModules(),
          ...fs,
          process,
          child_process: childProcess,
          os: createNodeOs(runtime.processContext),
          path,
          "path/posix": path.posix,
          "path/win32": path.win32,
          module: environment.module,
          constants: createNodeConstants(NodeConstants, fs.fs),
        };
        output.milestones.push("host-ready");
        observation.startDeadline();
        try {
          await Promise.race([
            runtime.cpuRoot.run(() => {
              leaveCpuUser = runtime.cpuRoot.enterUser();
              return bootNodeRelease(
                { modules, globals: { Bun: bun, process } },
                async (installed) => {
                  bridge = installed;
                  output.milestones.push("package-load-start");
                  packageLoad = await environment.load();
                  output.milestones.push("package-load-returned");
                  if (config.packagesOnly) {
                    complete("package-load-success");
                    return;
                  }
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
                },
              );
            }),
            done,
          ]);
        } catch (error) {
          guestError("release-error", error);
        }
        await done;
        stopCpuAccounting();
        const scenarioResult =
          config.scenario === "tools"
            ? await verifyCommittedToolScenario(filesystemHost, output, mock)
            : undefined;
        return Response.json({
          ...output,
          packageLoad,
          scenario: config.scenario,
          prompt: { estimatedTokens: prompt.estimatedTokens, paddingBytes: prompt.paddingBytes },
          scenarioResult,
          pins: config.pins,
          assetsSeeded: this.assetsSeeded,
          programsSeeded: this.programSeedRoute?.seeded ?? false,
          ok: config.packagesOnly
            ? packageLoad !== undefined && output.errors.length === 0
            : terminalSuccess(output) && (scenarioResult?.ok ?? mock.complete),
          mock: { requests: mock.requests, denied: mock.deniedRequests, complete: mock.complete },
          process: {
            same: Object.is(globalThis.process, process),
            cwd: process.cwd(),
            filesystemCwd: filesystem.cwd,
          },
          filesystem: { cwd: filesystem.cwd, workEntries: fs.fs.readdirSync("/work") },
        });
      } finally {
        stopCpuAccounting();
        observation.restore();
      }
    }
  };
}
