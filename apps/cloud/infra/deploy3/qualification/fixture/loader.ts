import { readRpcData, withRpcStub, rpcStubOwner } from "../../../../src/rpc/Resources.ts";
import { requireClaudeAuthorities } from "./claudeAuthorities.ts";
import { observeCommandInvocation } from "./commandObservation.ts";
import { WorkerEntrypoint } from "cloudflare:workers";
import { createAssetChildWorkerLoader } from "../../../../src/computer/CompiledChildWorkerLoader.ts";
import type { ChildWorkerLoaderPort } from "../../../../src/computer/WorkerLoaderDispatch.ts";
import type { ChildWorkerInvocation } from "../../../../src/computer/ChildWorkerProgram.ts";
import {
  observeWorkerCode,
  platformLoader,
  registerObservedLoader,
  type ObserverLoaderPin,
} from "./loaderObservation.ts";
import type { QualifierEnvironment } from "./environment.ts";
import { proof } from "./environment.ts";
import { readAsset, readConfiguration } from "./configuration.ts";
import { assert, sha256 } from "./common.ts";
import { COMMAND_ASSETS } from "./programRegistry.ts";
import { prepareClaudeFacetCode } from "../prepareClaudeFacet.ts";
import { CLAUDE_THREAD_ROUTE } from "./claudeDispatch.ts";
import { assertQualifierCodexFacetConfiguration } from "../facetEnvironmentContract.ts";
import { assertQualifierClaudeFacetConfiguration } from "../claudeCalibrationFacetContract.ts";

function facetPin(
  loaderId: string,
  fresh: boolean,
  phase?: { route: string; logicalIncarnation: number },
): ObserverLoaderPin {
  if (loaderId.startsWith("observer-calibration-"))
    return {
      loaderId,
      role: "facet",
      entrypoint: "CodexFacet",
      identity: "facet:calibration",
      tag: "actual-codex-facet-calibration",
      calls: {
        identity: [{ callId: "*", route: { method: "POST", path: "/observer-calibration" } }],
        isolateNonceProbe: [
          { callId: "*", route: { method: "POST", path: "/observer-calibration" } },
        ],
        observerCalibration: [
          {
            callId: "actual-facet-calibration",
            route: { method: "POST", path: "/observer-calibration" },
          },
        ],
      },
    };
  assert(phase, "Native facet construction has no logical owner or route");
  const path = phase.route;
  const call = (path: string) => [{ callId: "*", route: { method: "POST", path } }];
  return {
    loaderId,
    role: "facet",
    entrypoint: "CodexFacet",
    identity: phase.logicalIncarnation === 0 ? "facet:A" : "facet:B",
    tag: "actual-codex-facet",
    calls: {
      identity: call(path),
      isolateNonceProbe: call(path),
      startFresh: call("/turn/1/dispatch"),
      prepareInert: call(path),
      loadedPreparedRelease: call(path),
      observerCalibration: call("/observer-calibration"),
      run: [1, 2, 3].map((turn) => ({
        callId: `turn-${turn}`,
        route: { method: "POST", path: `/turn/${turn}/dispatch` },
      })),
      dispose: call(fresh ? "/turn/1/dispatch" : "/finish/dispatch"),
    },
  };
}

/** Adds observation at the platform code boundary; C still owns its original loader and facet. */
export function qualifierFacetLoader(env: QualifierEnvironment, tail: Fetcher): WorkerLoader {
  // A caller holding the shard's environment passes an already-observing loader; observing through
  // it again would prepare and materialize every owner twice, so always reach the platform loader.
  const platform = platformLoader(env.LOADER);
  return registerObservedLoader(platform, {
    get(name, getCode) {
      assert(typeof name === "string" && name.length > 0, "Facet loader identity is missing");
      return platform.get(name, async () => {
        const actual = await getCode();
        const config = await readConfiguration(env.PROGRAM_ASSETS, env.CONFIG_SHA256);
        // Claude turns run on the product thread host; C only loads the import calibration.
        if (actual.mainModule === "qualifier-claude-calibration-facet.mjs") {
          const prepared = await prepareClaudeFacetCode(actual, config, env.PROGRAM_ASSETS, {
            RUN_ID: env.RUN_ID,
            CONFIG_SHA256: env.CONFIG_SHA256,
            authorities: requireClaudeAuthorities(env),
          });
          assertQualifierClaudeFacetConfiguration(prepared.code.env);
          const route = (path: string) => ({ method: "POST", path });
          const variant = prepared.variant;
          const pin: ObserverLoaderPin = {
            loaderId: name,
            role: "facet",
            entrypoint: "ClaudeImportCalibrationFacet",
            identity: `facet:claude:${variant}:${name}`,
            tag: "actual-claude-facet",
            calls: {
              identity: [{ callId: "*", route: route(`/claude/${variant}/inspect`) }],
              isolateNonceProbe: [{ callId: "*", route: route(`/claude/${variant}/inspect`) }],
              loadedPreparedRelease: [{ callId: "*", route: route(`/claude/${variant}/release`) }],
              startFresh: [{ callId: "*", route: route(`/claude/${variant}/restore`) }],
              run: [1, 2, 3].map((turn) => ({
                callId: `${variant}-turn-${turn}`,
                route: route(`/claude/${variant}/turn/${turn}/dispatch`),
              })),
              prepareInert: [{ callId: "*", route: route(`/claude/${variant}/replace/dispatch`) }],
              dispose: [{ callId: "*", route: route(`/claude/${variant}/finish/dispatch`) }],
              observerCalibration: [
                { callId: "*", route: route(`/claude/${variant}/calibration`) },
              ],
            },
          };
          const observed = observeWorkerCode(prepared.code, env.RUN_ID, pin, tail);
          await withRpcStub(proof(env), async (stub) =>
            readRpcData(
              stub.append("actual-claude-loader-materialized", {
                name,
                pin,
                mainModule: actual.mainModule,
                modules: Object.keys(observed.code.modules),
              }),
            ),
          );
          return observed.code;
        }
        assert(actual.mainModule === "qualifier-facet.mjs", "C selected an undeclared facet main");
        const enriched = {
          ...actual,
          modules: {
            ...actual.modules,
            "qualifier-implementation.mjs": { js: config.facetSource },
          },
        };
        const phase = name.startsWith("observer-calibration-")
          ? undefined
          : await withRpcStub(proof(env), async (stub) =>
              readRpcData(stub.modelConstructionPhase()),
            );
        if (phase !== undefined) assertQualifierCodexFacetConfiguration(actual.env);
        const pin = facetPin(name, actual.env?.HARNESS_RESUME_CREATION === true, phase);
        const observed = observeWorkerCode(enriched, env.RUN_ID, pin, tail);
        await withRpcStub(proof(env), async (stub) =>
          readRpcData(
            stub.append("actual-loader-materialized", {
              name,
              pin,
              mainModule: actual.mainModule,
              modules: Object.keys(observed.code.modules),
            }),
          ),
        );
        return observed.code;
      });
    },
    load: (code) => platform.load(code),
  });
}

export class QualifierCommands extends WorkerEntrypoint<QualifierEnvironment> {
  async run(input: ChildWorkerInvocation, target: Parameters<ChildWorkerLoaderPort["run"]>[1]) {
    const owner = proof(this.env);
    using _ownerStub = rpcStubOwner(owner);
    const phase = await readRpcData(owner.commandPhase());
    const tool =
      input.command.executable === "/bin/rg" ? await readRpcData(owner.commandToolUse()) : null;
    const tail = this.env.QUALIFIER_TAIL;
    const original = this.env.LOADER;
    const loader: WorkerLoader = {
      get: (name, getCode) => {
        assert(typeof name === "string", "Command loader identity is missing");
        return original.get(name, async () => {
          const actual = await getCode();
          const pin: ObserverLoaderPin = {
            loaderId: name,
            role: "command",
            entrypoint: input.entrypoint ?? "default",
            identity: `command:${input.entrypoint ?? "default"}`,
            tag: "actual-command-run",
            calls: {
              run: [
                "/observer-calibration",
                "/replace/dispatch",
                ...[1, 2, 3].map((turn) => `/turn/${turn}/dispatch`),
                CLAUDE_THREAD_ROUTE,
              ].map((path) => ({ callId: path, route: { method: "POST", path } })),
            },
          };
          const observed = observeWorkerCode(actual, this.env.RUN_ID, pin, tail);
          await readRpcData(
            owner.append("actual-command-loader-materialized", {
              name,
              pin,
              mainModule: actual.mainModule,
              modules: Object.keys(observed.code.modules),
            }),
          );
          return observed.code;
        });
      },
      load: (code) => original.load(code),
    };
    // @effect-diagnostics-next-line cryptoRandomUUID:off - The platform command boundary assigns the raw trace identity before entering the child.
    const invocationId = crypto.randomUUID();
    const exit = await createAssetChildWorkerLoader(loader, async (hash) => {
      const asset = COMMAND_ASSETS.get(hash);
      if (asset === undefined) return undefined;
      return (await readAsset(this.env.PROGRAM_ASSETS, { ...asset, sha256: hash })).buffer;
    }).run(
      { ...input, command: observeCommandInvocation(input.command, phase, invocationId) },
      target,
    );
    if (input.command.executable === "/bin/rg")
      await readRpcData(
        owner.append("kernel-rg-completed", {
          runId: this.env.RUN_ID,
          invocationId,
          toolUseId: tool?.id,
          toolName: tool?.name,
          publicRequestId: tool?.publicRequestId,
          variant: tool?.variant,
          loaderId: input.loaderId,
          route: { method: "POST", path: phase },
          executable: input.command.executable,
          argv: input.command.argv,
          cwd: input.command.cwd,
          wasmReferences: Object.values(input.modules).flatMap((module) =>
            typeof module === "object" && "wasmReference" in module ? [module.wasmReference] : [],
          ),
          exit,
        }),
      );
    return exit;
  }
}

export class QualifierTail extends WorkerEntrypoint<QualifierEnvironment> {
  async captureOuter(items: TraceItem[]) {
    return await withRpcStub(proof(this.env), async (stub) =>
      readRpcData(stub.tailRecords(items, "outer-platform")),
    );
  }
  override async tail(items: TraceItem[]) {
    assert(Array.isArray(items) && items.length > 0, "The platform delivered an empty tail batch");
    const plainItems: TraceItem[] = JSON.parse(JSON.stringify(items));
    await withRpcStub(proof(this.env), async (stub) => readRpcData(stub.tailRecords(plainItems)));
    for (const item of plainItems) {
      const raw = JSON.stringify(item);
      const bytes = new TextEncoder().encode(raw);
      assert(bytes.length < 96 * 1024, "Raw dynamic trace exceeds the complete forwarding limit");
      // @effect-diagnostics-next-line globalConsole:off - The observer ingests this exact JSON log payload from the platform tail.
      console.log(
        JSON.stringify({
          qualifierRawTrace: { raw, bytes: bytes.length, sha256: await sha256(bytes) },
        }),
      );
    }
  }
}
