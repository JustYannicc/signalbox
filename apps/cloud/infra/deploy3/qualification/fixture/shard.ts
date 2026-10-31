import { placementReleaseEvidence } from "./placementReleaseObserver.fixture.ts";
import { disposeWorkerLoaderStubs } from "../../../../src/computer/WorkerLoaderDispatch.ts";
import { HarnessProcessExecutionShardObject } from "../../../../src/harness/HarnessProcessExecutionShardObject.ts";
import { HARNESS_C_PRODUCT_CAPABILITY_KEYS } from "../../../../src/harness/HarnessCProductCapabilities.ts";
import { createQualifierShardEnvironment } from "../shardEnvironment.ts";
import type { QualifierEnvironment } from "./environment.ts";
import { proof } from "./environment.ts";
import { qualifierFacetLoader } from "./loader.ts";
import { readConfiguration } from "./configuration.ts";
import {
  createHarnessProcessFacetEnvironment,
  preparedReleaseAsset,
  materializeHarnessProcessModules,
} from "../../../../src/harness/HarnessProcessPlacement.ts";
import { assert } from "./common.ts";
import { readShardRecoveryEvidence, readShardExecutionEvidence } from "./shardEvidence.ts";
import { assertQualifierRuntimeConfiguration } from "../environmentContract.ts";

export class QualifierShard extends HarnessProcessExecutionShardObject {
  private readonly qualifierEnvironment: QualifierEnvironment;
  constructor(ctx: DurableObjectState, env: QualifierEnvironment) {
    assertQualifierRuntimeConfiguration(env);
    const cap = proof(env) as unknown as Fetcher;
    const exports = {
      QualifierCommands: env.QUALIFIER_COMMANDS,
      QualifierTail: env.QUALIFIER_TAIL,
    };
    super(
      ctx,
      createQualifierShardEnvironment(env, qualifierFacetLoader(env, exports.QualifierTail), cap),
    );
    this.qualifierEnvironment = env;
  }
  async observerCalibration() {
    const env = this.qualifierEnvironment;
    const config = await readConfiguration(env.PROGRAM_ASSETS, env.CONFIG_SHA256);
    const release = config.expectedRelease;
    const engine = Object.entries(release.plan.preparedModules).find(
      ([, value]) => value.type === "wasm" && value.path.endsWith("codex/engine.wasm"),
    );
    assert(engine, "The actual engine module is missing from calibration build");
    const cap = proof(env);
    await cap.append("observer-calibration-materialize-entered", { officialNativeStarted: false });
    const key = `observer-calibration-${env.RUN_ID}`;
    const facetCode = {
      processId: "observer-calibration",
      codeId: release.artifact.releaseId,
      residentBytes: 104 * 1024 * 1024,
      mainModule: "qualifier-facet.mjs",
      entrypoint: "CodexFacet",
      modules: {
        "qualifier-facet.mjs": {
          js: "export { CodexFacet } from './qualifier-implementation.mjs';\n",
        },
        "codex-engine.wasm": preparedReleaseAsset(release, engine[0]),
      },
      productBootstrap: {
        provider: "codex",
        preparedReleaseId: release.artifact.releaseId,
        restoreMode: "same-variant-serialized-checkpoint",
      },
      targetPreparedRelease: release,
    } as const;
    const facetEnvironment = createHarnessProcessFacetEnvironment(
      facetCode,
      {
        ...env,
        HARNESS_C_PRODUCT_CAPABILITIES: {
          [HARNESS_C_PRODUCT_CAPABILITY_KEYS.release]: cap,
          qualifierCommands: env.QUALIFIER_COMMANDS,
        },
      },
      { shardOwner: "qualifier/observer-calibration", loaderId: key, facetKey: key },
      this.ctx,
    );
    const constructorAssets = facetEnvironment.PROGRAM_ASSETS as Fetcher | undefined;
    assert(constructorAssets, "Public product constructor omitted its assets binding");
    const constructorConfiguration = await readConfiguration(constructorAssets, env.CONFIG_SHA256);
    assert(
      constructorConfiguration.runId === config.runId,
      "Constructor-bound assets changed the calibration run",
    );
    const executionEnvironment = {
      constructorPath: "createHarnessProcessFacetEnvironment",
      assetsRoundTrip: true,
      configSha256: env.CONFIG_SHA256,
      nativeStarted: false,
    };
    await cap.append("observer-execution-environment-constructed", executionEnvironment);
    const modules = await materializeHarnessProcessModules(
      facetCode.modules,
      release,
      (artifactRef, path, offset, length) =>
        cap.readArtifactChunk(artifactRef, path, offset, length),
    );
    await cap.append("observer-calibration-materialized", { modules: Object.keys(modules) });
    const exports = { QualifierTail: env.QUALIFIER_TAIL };
    const loader = qualifierFacetLoader(env, exports.QualifierTail);
    const worker = loader.get(key, () => ({
      compatibilityDate: "2026-10-19",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: facetCode.mainModule,
      modules,
      env: facetEnvironment,
      globalOutbound: null,
    }));
    type CalibrationFacet = Rpc.DurableObjectBranded & {
      identity(): Promise<{ facetNonce: string }>;
      observerCalibration(input: {
        invocationId: string;
      }): Promise<{ incarnation: string; nativeStarted: false }>;
    };
    const type = worker.getDurableObjectClass<CalibrationFacet>("CodexFacet");
    const facet = this.ctx.facets.get<CalibrationFacet>(key, () => ({ class: type }));
    try {
      await cap.append("observer-calibration-facet-created", { key });
      const identity = await facet.identity();
      await cap.append("observer-calibration-facet-identity", identity);
      const observed = await facet.observerCalibration({
        invocationId: "actual-facet-calibration",
      });
      await cap.append("observer-calibration-facet-returned", observed);
      assert(
        observed.incarnation === identity.facetNonce && observed.nativeStarted === false,
        "Actual inert facet calibration started native execution or changed its identity",
      );
      return { identity, observed, executionEnvironment, loaderId: key, nativeStarted: false };
    } finally {
      this.ctx.facets.abort(key, "Inert observer calibration completed without native execution");
      this.ctx.facets.delete(key);
      disposeWorkerLoaderStubs(worker);
    }
  }
  async modelRecoveryEvidence(runId: string) {
    return readShardRecoveryEvidence(this.ctx.storage, () => this.processIncarnationFence(), runId);
  }
  placementReleaseEvidence() {
    return placementReleaseEvidence(this.ctx.storage);
  }
  async evidence() {
    return readShardExecutionEvidence(this.ctx.storage, () => this.executionIncarnationNonce());
  }
}
