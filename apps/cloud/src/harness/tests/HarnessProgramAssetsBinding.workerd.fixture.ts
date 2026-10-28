import { DurableObject } from "cloudflare:workers";
import {
  createHarnessProcessFacetEnvironment,
  type HarnessProcessExecutionProcessInput,
} from "../HarnessProcessPlacement.ts";
import type {
  HarnessCProductBootstrapDescriptor,
  HarnessProcessResumePreparedRelease,
} from "../HarnessProcessResume.ts";

const releaseId = "program-assets-probe-release";
const processInput = {
  processId: "program-assets-probe-process",
  codeId: "program-assets-probe-code",
  residentBytes: 1,
  nativeSessionId: "program-assets-probe-session",
  checkpointId: "program-assets-probe-checkpoint",
  manifestRevision: "0".repeat(64),
  operationId: "program-assets-probe-operation",
  priorFacetNonce: "program-assets-probe-prior-facet",
  expectedFacetGeneration: 1,
  mainModule: "program-assets-probe.js",
  modules: {
    "program-assets-probe.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export class ProgramAssetsProbe extends WorkerEntrypoint {
  fetch(request) { return this.env.PROGRAM_ASSETS.fetch(request); }
}`,
  },
  entrypoint: "ProgramAssetsProbe",
  facetEnv: { PROGRAM_ASSETS: "caller-supplied-value-is-dropped" },
  productBootstrap: {
    provider: "codex",
    preparedReleaseId: releaseId,
    restoreMode: "cross-variant-fresh-boot",
  } as HarnessCProductBootstrapDescriptor,
  targetPreparedRelease: {
    artifact: { provider: "codex", releaseId },
  } as HarnessProcessResumePreparedRelease,
} satisfies HarnessProcessExecutionProcessInput;

interface Env {
  readonly ASSET_PROXY_TEST: DurableObjectNamespace<ProgramAssetsProbeObject>;
  readonly LOADER: WorkerLoader;
  readonly PROGRAM_ASSETS: Fetcher;
}

export class ProgramAssetsProbeObject extends DurableObject<Env> {
  async roundTrip(path: string) {
    const workerEnv = createHarnessProcessFacetEnvironment(
      processInput,
      this.env,
      {
        shardOwner: "program-assets-owner",
        loaderId: "program-assets-loader",
        facetKey: "program-assets-facet",
      },
      this.ctx,
    );
    const worker = this.env.LOADER.get("program-assets-probe-loader", () => ({
      compatibilityDate: "2026-10-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: processInput.mainModule,
      modules: processInput.modules,
      env: workerEnv,
      globalOutbound: null,
    }));
    const probe = worker.getEntrypoint("ProgramAssetsProbe") as unknown as {
      fetch(request: Request): Promise<Response>;
    };

    try {
      const response = await probe.fetch(
        new Request(`https://program-assets.invalid${path}`, {
          method: "POST",
          headers: { "x-program-assets-request": "preserved header" },
          body: "preserved request body",
        }),
      );
      return {
        status: response.status,
        statusText: response.statusText,
        contentType: response.headers.get("content-type"),
        responseHeader: response.headers.get("x-program-assets-response"),
        body: await response.text(),
      };
    } catch (cause) {
      return {
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const result = await env.ASSET_PROXY_TEST.getByName("program-assets").roundTrip(
      new URL(request.url).pathname === "/error"
        ? "/error"
        : new URL(request.url).pathname === "/throw"
          ? "/throw"
          : "/roundtrip",
    );
    return Response.json(result);
  },
};
export * from "../../FixtureWorkerExports.ts";
