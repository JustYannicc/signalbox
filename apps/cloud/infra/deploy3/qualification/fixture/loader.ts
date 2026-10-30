import { HARNESS_C_PRODUCT_CAPABILITY_KEYS } from "../../../../src/harness/HarnessCProductCapabilities.ts";
import { observeCommandInvocation } from "../../../../src/harness/tests/CommandObservation.fixture.ts";
import { WorkerEntrypoint } from "cloudflare:workers";
import { createCompiledChildWorkerLoader } from "../../../../src/computer/CompiledChildWorkerLoader.ts";
import type { ChildWorkerLoaderPort } from "../../../../src/computer/WorkerLoaderDispatch.ts";
import type { ChildWorkerInvocation } from "../../../../src/computer/ChildWorkerProgram.ts";
import { observeWorkerCode, type ObserverLoaderPin } from "./loaderObservation.ts";
import type { QualifierEnvironment } from "./environment.ts";
import { proof } from "./environment.ts";
import { readConfiguration } from "./configuration.ts";
import { assert, sha256 } from "./common.ts";
import { COMMAND_REGISTRY } from "./programRegistry.ts";
import { prepareClaudeFacetCode } from "../prepareClaudeFacet.ts";

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
  return {
    get(name, getCode) {
      assert(typeof name === "string" && name.length > 0, "Facet loader identity is missing");
      return env.LOADER.get(name, async () => {
        const actual = await getCode();
        const config = await readConfiguration(env.PROGRAM_ASSETS, env.CONFIG_SHA256);
        if (actual.mainModule === "qualifier-claude-facet.mjs") {
          const prepared = await prepareClaudeFacetCode(
            {
              ...actual,
              env: {
                ...actual.env,
                ...(env.CLAUDE_ACCESS ? { CLAUDE_ACCESS: env.CLAUDE_ACCESS } : {}),
                ...(env.CLAUDE_EXECUTOR ? { CLAUDE_EXECUTOR: env.CLAUDE_EXECUTOR } : {}),
                HARNESS_C_PRODUCT_CAPABILITIES: {
                  ...actual.env?.HARNESS_C_PRODUCT_CAPABILITIES,
                  ...(env.CLAUDE_ACCESS
                    ? { [HARNESS_C_PRODUCT_CAPABILITY_KEYS.access]: env.CLAUDE_ACCESS }
                    : {}),
                  ...(env.CLAUDE_EXECUTOR
                    ? { [HARNESS_C_PRODUCT_CAPABILITY_KEYS.executor]: env.CLAUDE_EXECUTOR }
                    : {}),
                  ...(env.CLAUDE_CONTINUATION_PUBLISHER
                    ? { claudeContinuationPublisher: env.CLAUDE_CONTINUATION_PUBLISHER }
                    : {}),
                },
              },
            },
            config,
            env.PROGRAM_ASSETS,
          );
          const route = (path: string) => ({ method: "POST", path });
          const calibration = route(`/claude/${prepared.variant}/calibration`);
          const restore = route(`/claude/${prepared.variant}/restore`);
          const step = await proof(env).claudeStepForLoader();
          const run = route(
            step
              ? `/claude/${prepared.variant}/${step.phase}/dispatch`
              : `/claude/${prepared.variant}/restore`,
          );
          const pin: ObserverLoaderPin = {
            loaderId: name,
            role: "facet",
            entrypoint: "ClaudeFacet",
            identity: `facet:claude:${prepared.variant}`,
            tag: "actual-claude-facet",
            calls: {
              identity: [{ callId: "*", route: route(`/claude/${prepared.variant}/inspect`) }],
              isolateNonceProbe: [
                { callId: "*", route: route(`/claude/${prepared.variant}/inspect`) },
              ],
              loadedPreparedRelease: [
                { callId: "*", route: route(`/claude/${prepared.variant}/release`) },
              ],
              run: [{ callId: "*", route: run }],
              prepareInert: [{ callId: "*", route: restore }],
              dispose: [{ callId: "*", route: route(`/claude/${prepared.variant}/dispose`) }],
              observerCalibration: [{ callId: "*", route: calibration }],
            },
          };
          const observed = observeWorkerCode(prepared.code, env.RUN_ID, pin, tail);
          await proof(env).append("actual-claude-loader-materialized", {
            name,
            pin,
            mainModule: actual.mainModule,
            modules: Object.keys(observed.code.modules),
          });
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
          : await proof(env).modelConstructionPhase();
        const pin = facetPin(name, actual.env?.HARNESS_RESUME_CREATION === true, phase);
        const observed = observeWorkerCode(enriched, env.RUN_ID, pin, tail);
        await proof(env).append("actual-loader-materialized", {
          name,
          pin,
          mainModule: actual.mainModule,
          modules: Object.keys(observed.code.modules),
        });
        return observed.code;
      });
    },
    load: (code) => env.LOADER.load(code),
  };
}

export class QualifierCommands extends WorkerEntrypoint<QualifierEnvironment> {
  async run(input: ChildWorkerInvocation, target: Parameters<ChildWorkerLoaderPort["run"]>[1]) {
    const owner = proof(this.env);
    const phase = await owner.commandPhase();
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
              ].map((path) => ({ callId: path, route: { method: "POST", path } })),
            },
          };
          const observed = observeWorkerCode(actual, this.env.RUN_ID, pin, tail);
          await owner.append("actual-command-loader-materialized", {
            name,
            pin,
            mainModule: actual.mainModule,
            modules: Object.keys(observed.code.modules),
          });
          return observed.code;
        });
      },
      load: (code) => original.load(code),
    };
    return await createCompiledChildWorkerLoader(loader, COMMAND_REGISTRY).run(
      { ...input, command: observeCommandInvocation(input.command, phase, crypto.randomUUID()) },
      target,
    );
  }
}

export class QualifierTail extends WorkerEntrypoint<QualifierEnvironment> {
  async captureOuter(items: TraceItem[]) {
    return await proof(this.env).tailRecords(items, "outer-platform");
  }
  override async tail(items: TraceItem[]) {
    assert(Array.isArray(items) && items.length > 0, "The platform delivered an empty tail batch");
    const plainItems: TraceItem[] = JSON.parse(JSON.stringify(items));
    await proof(this.env).tailRecords(plainItems);
    for (const item of plainItems) {
      const raw = JSON.stringify(item);
      const bytes = new TextEncoder().encode(raw);
      assert(bytes.length < 96 * 1024, "Raw dynamic trace exceeds the complete forwarding limit");
      console.log(
        JSON.stringify({
          qualifierRawTrace: { raw, bytes: bytes.length, sha256: await sha256(bytes) },
        }),
      );
    }
  }
}
