// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalDate:off - isolated diagnostic host without an Effect runtime.
import { DurableObject } from "cloudflare:workers";
import { ChildWorkerCapacity } from "../../src/computer/ChildWorkerCapacity.ts";
import type { ChildWorkerLoaderPort } from "../../src/computer/WorkerLoaderDispatch.ts";
import * as NodeConstants from "node:constants";
import { createNodeConstants } from "../../src/isolate/NodeConstants.ts";
import { createNodeOs } from "../../src/isolate/NodeOs.ts";
import { createNodePath } from "../../src/isolate/NodePath.ts";
import { bootNodeRelease } from "../../src/isolate/NodeBootstrap.ts";
import type { NodeBridge } from "../../src/isolate/NodeBridge.ts";
import { createProofEnvironment } from "../claudeTurnProof/proofEnvironment.ts";
import { createProofFilesystemHost } from "../claudeTurnProof/proofFilesystem.ts";
import {
  createPreparedAssetModuleResolver,
  type PreparedAssetModuleCatalog,
} from "../claudeTurnProof/preparedAssetModules.ts";
import {
  createProofExecutableSeedRoute,
  type ProofExecutableFileCatalog,
} from "../claudeTurnProof/proofExecutableSeed.ts";
import {
  createProofProcessEnvironment,
  createProofIdentity,
} from "../claudeTurnProof/proofEnvironment.ts";
import { createMockMessagesApi } from "../claudeTurnProof/mockMessages.ts";
import { getNativeHostModules } from "../claudeTurnProof/proofNativeModules.ts";
import {
  createGuestObservation,
  errorDetail,
  readAssetBody,
} from "../claudeTurnProof/proofObservation.ts";
import { terminalSuccess, proofPrompt } from "../claudeTurnProof/proofScenario.ts";
import { decodeVerifiedAssetBundle } from "../claudeTurnProof/assetBundle.ts";
import { verifySeededAssets } from "../claudeTurnProof/proofAssets.ts";
import type { ClaudeTurnProofConfig } from "../claudeTurnProof/ClaudeTurnProof.ts";
import type { ChildProgramSources } from "../childPrograms/prepare.ts";
import type { NodeGeneratedCodeOpenPort } from "../../src/isolate/NodeGeneratedCode.ts";
import { createClaudeHookRuntime } from "./claudeRuntime.ts";
import type { ClaudeHooksDispatchRecord } from "./claudeEvidence.ts";
import { runClaudeProofLifecycle } from "./claudeLifecycle.ts";
import { createStandardProofAdapter, type StandardProofAdapter } from "./standardProofAdapter.ts";
import { installStandardProofFiles } from "./standardProofFiles.ts";
import {
  claudeToolScript,
  createClaudeHookScenario,
  seedClaudeHookScenario,
  verifyClaudeHookScenario,
} from "./claudeScenario.ts";

/** Same factory shape as the regular proof, selected by prepareClaudeTurnProof(hostRuntime). */
export function createClaudeTurnProofClass(
  config: Omit<ClaudeTurnProofConfig, "programs"> & {
    readonly childPrograms: ChildProgramSources;
  },
): new (ctx: DurableObjectState, env: Cloudflare.Env) => DurableObject {
  const programs = config.childPrograms;
  const programFiles = config.programFiles;
  if (programs === undefined || programFiles === undefined) {
    throw new Error("Claude hooks proof requires the pinned Bash, BusyBox and ripgrep programs");
  }
  return class ClaudeHooksProof extends DurableObject {
    private readonly capacity = new ChildWorkerCapacity();
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
        if (path !== "/boot")
          return Response.json({ ok: false, error: "Unknown proof endpoint" }, { status: 404 });
        if (config.requireSeed && !this.assetsSeeded) {
          throw new Error("ERR_DIAGNOSTIC_ASSETS_NOT_SEEDED");
        }
        if (!this.programSeedHandler().seeded)
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
      const catalog = programFiles as ProofExecutableFileCatalog;
      return (this.programSeedRoute ??= createProofExecutableSeedRoute({
        catalog,
        filesystem: () => this.filesystem().filesystem,
        storage: this.ctx.storage,
      }));
    }

    private async seedPrograms(request: Request) {
      return await this.programSeedHandler().handle(request, {
        bootStarted: this.bootStarted,
        assetsRequired: config.requireSeed,
        assetsSeeded: this.assetsSeeded,
      });
    }

    private async boot() {
      const observation = createGuestObservation();
      const { output, done, complete, guestError, streams } = observation;
      const originalFetch = globalThis.fetch;
      let runtime: ReturnType<typeof createClaudeHookRuntime> | undefined;
      let standard: StandardProofAdapter | undefined;
      let restoreFiles: (() => void) | undefined;
      let lifecycleOwnsRuntime = false;
      const restore = () => {
        try {
          globalThis.fetch = originalFetch;
        } finally {
          try {
            restoreFiles?.();
            standard?.close();
          } finally {
            observation.restore();
          }
        }
      };
      try {
        const filesystemHost = this.filesystem();
        const mock = createMockMessagesApi({
          bootText: "mock",
          finalText: "mock",
          recordRequestBodies: true,
          tools: [claudeToolScript()],
        });
        standard = createStandardProofAdapter(
          this.ctx.storage,
          "claude-standard-hooks",
          (request) => mock.fetch(request),
        );
        await standard.prepare();
        restoreFiles = installStandardProofFiles(filesystemHost.fs, standard);
        const scenario = createClaudeHookScenario(standard.callback);
        seedClaudeHookScenario(filesystemHost, scenario.settings);
        const modelGateway = standard;
        globalThis.fetch = (input, init) => modelGateway.serve(new Request(input, init));
        const env = createProofProcessEnvironment();
        const prompt = proofPrompt("tools", config.contextTokenEquivalent);
        const identity = createProofIdentity(prompt.text);
        const dispatches: ClaudeHooksDispatchRecord[] = [];
        runtime = createClaudeHookRuntime({
          capacity: this.capacity,
          ...filesystemHost,
          storage: this.ctx.storage,
          programs,
          loader: {
            run: (invocation, capability) =>
              (
                this.env as Cloudflare.Env & { CHILD_WORKERS: ChildWorkerLoaderPort }
              ).CHILD_WORKERS.run(invocation, capability),
          },
          env,
          identity,
          streams,
          assets: config.assets,
          isSeeded: () => this.assetsSeeded,
          onMissing: (member) => output.bunMissing.push(member),
          codeGeneration: (
            this.env as Cloudflare.Env & { CODE_GENERATION: NodeGeneratedCodeOpenPort }
          ).CODE_GENERATION,
          scenario,
          dispatches,
          standard,
        });
        runtime.process.on("exit", (code: number) => {
          output.exitCode = code;
          complete("process-exit");
        });
        let bridge: NodeBridge;
        const environment = createProofEnvironment({
          bridge: () => bridge,
          loadPackages: config.loadPackages,
          onBuiltinFailure: (specifier) => output.builtinMissing.push(specifier),
          prepared: createPreparedAssetModuleResolver({
            assets: config.assets as PreparedAssetModuleCatalog,
            fs: filesystemHost.fs,
            isSeeded: () => this.assetsSeeded,
          }),
        });
        let packageLoad: Awaited<ReturnType<typeof environment.load>> | undefined;
        const path = createNodePath(filesystemHost.filesystem);
        const modules = {
          ...getNativeHostModules(),
          ...filesystemHost.fs,
          process: runtime.process,
          child_process: runtime.childProcess,
          os: createNodeOs(runtime.processContext),
          path,
          "path/posix": path.posix,
          "path/win32": path.win32,
          module: environment.module,
          constants: createNodeConstants(NodeConstants, filesystemHost.fs.fs),
        };
        output.milestones.push("hook-host-ready");
        lifecycleOwnsRuntime = true;
        const lifecycle = await runClaudeProofLifecycle({
          runtime,
          terminal: done,
          guestError,
          restore,
          retain: (lifetime) => this.ctx.waitUntil(lifetime),
          launch: () =>
            bootNodeRelease(
              { modules, globals: { Bun: runtime!.bun, process: runtime!.process } },
              async (installed) => {
                bridge = installed;
                output.milestones.push("package-load-start");
                packageLoad = await environment.load();
                output.milestones.push("package-load-returned");
                output.milestones.push("release-import-start");
                const release = await config.loadRelease();
                output.milestones.push("release-import-returned");
                if (
                  !release ||
                  typeof release !== "object" ||
                  typeof Reflect.get(release, "launch") !== "function"
                ) {
                  throw new Error("ERR_DIAGNOSTIC_RELEASE_LAUNCH_MISSING");
                }
                output.milestones.push("release-launch-start");
                await Reflect.apply(Reflect.get(release, "launch"), release, []);
                output.milestones.push("release-launch-returned");
                return release;
              },
            ),
        });
        if (lifecycle.deadlineExceeded) {
          return Response.json({
            ...output,
            packageLoad,
            scenario: "official-claude-hooks",
            pins: config.pins,
            phase: "deadline",
            lifecycle,
            ok: false,
            mock: { requests: mock.requests, denied: mock.deniedRequests, complete: mock.complete },
          });
        }
        const scenarioResult = await verifyClaudeHookScenario({
          ...filesystemHost,
          dispatches,
          rpcCalls: scenario.rpcCalls,
          stdout: output.stdout,
          mockComplete: mock.complete,
          toolResults: mock.toolResults,
          machineCalls: runtime.machineCalls.count,
        });
        const terminalOk = terminalSuccess(output);
        const standardResult = standard.inspect();
        return Response.json({
          ...output,
          lifecycle,
          packageLoad,
          scenario: "official-claude-hooks",
          prompt: { estimatedTokens: prompt.estimatedTokens, paddingBytes: prompt.paddingBytes },
          scenarioResult,
          standard: {
            ...standardResult,
            nativeWrite: {
              kind: "whole-utf8-workspace-write-test-adapter",
              writes: standardResult.gateway.writes,
              sameByteLengthValues: true,
              variableLengthFill: "unproved",
              arbitraryFileReadScrubbing: "unproved",
            },
          },
          pins: config.pins,
          assetsSeeded: this.assetsSeeded,
          programsSeeded: this.programSeedHandler().seeded,
          ok:
            terminalOk &&
            scenarioResult.ok === true &&
            standardResult.ok &&
            standardResult.gateway.writes === 1 &&
            standardResult.modelGateway?.nativeForwardCount === mock.requests.length &&
            output.errors.length === 0 &&
            runtime.capacity.active === 0,
          mock: { requests: mock.requests, denied: mock.deniedRequests, complete: mock.complete },
          process: {
            same: Object.is(globalThis.process, runtime.process),
            cwd: runtime.process.cwd(),
            filesystemCwd: filesystemHost.filesystem.cwd,
          },
          filesystem: {
            cwd: filesystemHost.filesystem.cwd,
            workEntries: filesystemHost.fs.fs.readdirSync("/work"),
          },
          runtimeBoundary: "child-dynamic-workers",
          capacity: { active: runtime.capacity.active, limit: runtime.capacity.limit },
        });
      } finally {
        if (!lifecycleOwnsRuntime) {
          try {
            await runtime?.close();
          } finally {
            restore();
          }
        }
      }
    }
  };
}
