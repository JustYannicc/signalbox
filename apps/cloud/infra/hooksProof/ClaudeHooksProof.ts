// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalDate:off - isolated diagnostic host without an Effect runtime.
import { DurableObject } from "cloudflare:workers";
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
import type { NodeGeneratedCodeFetcher } from "../../src/isolate/NodeGeneratedCode.ts";
import { createClaudeHookRuntime, type ClaudeHooksDispatchRecord } from "./claudeRuntime.ts";
import {
  claudeToolScript,
  createClaudeHookScenario,
  seedClaudeHookScenario,
  verifyClaudeHookScenario,
} from "./claudeScenario.ts";

/** Same factory shape as the regular proof, selected by prepareClaudeTurnProof(hostRuntime). */
export function createClaudeTurnProofClass(
  config: ClaudeTurnProofConfig,
): new (ctx: DurableObjectState, env: Cloudflare.Env) => DurableObject {
  const programs = config.programs;
  const programFiles = config.programFiles;
  if (programs === undefined || programFiles === undefined) {
    throw new Error("Claude hooks proof requires the pinned Bash, BusyBox and ripgrep programs");
  }
  return class ClaudeHooksProof extends DurableObject {
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
      let leaveCpuUser: (() => void) | undefined;
      try {
        const scenario = createClaudeHookScenario();
        const filesystemHost = this.filesystem();
        seedClaudeHookScenario(filesystemHost, scenario.settings);
        const mock = createMockMessagesApi({
          bootText: "mock",
          finalText: "mock",
          recordRequestBodies: true,
          tools: [claudeToolScript()],
        });
        globalThis.fetch = mock.fetch;
        const env = createProofProcessEnvironment();
        const prompt = proofPrompt("tools", config.contextTokenEquivalent);
        const identity = createProofIdentity(prompt.text);
        const dispatches: ClaudeHooksDispatchRecord[] = [];
        runtime = createClaudeHookRuntime({
          ...filesystemHost,
          storage: this.ctx.storage,
          programs,
          env,
          identity,
          streams,
          assets: config.assets,
          isSeeded: () => this.assetsSeeded,
          onMissing: (member) => output.bunMissing.push(member),
          codeGeneration: (
            this.env as Cloudflare.Env & { CODE_GENERATION: NodeGeneratedCodeFetcher }
          ).CODE_GENERATION,
          scenario,
          dispatches,
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
        observation.startDeadline();
        try {
          await Promise.race([
            runtime.cpuRoot.run(() => {
              leaveCpuUser = runtime!.enterUser();
              return bootNodeRelease(
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
              );
            }),
            done,
          ]);
        } catch (error) {
          guestError("release-error", error);
        }
        await done;
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
        return Response.json({
          ...output,
          packageLoad,
          scenario: "official-claude-hooks",
          prompt: { estimatedTokens: prompt.estimatedTokens, paddingBytes: prompt.paddingBytes },
          scenarioResult,
          pins: config.pins,
          assetsSeeded: this.assetsSeeded,
          programsSeeded: this.programSeedHandler().seeded,
          ok: terminalOk && scenarioResult.ok === true && output.errors.length === 0,
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
          runtimeBoundary: "proof-local Bash binding; child-worker Bash binding remains pending",
        });
      } finally {
        leaveCpuUser?.();
        runtime?.close();
        globalThis.fetch = originalFetch;
        observation.restore();
      }
    }
  };
}
