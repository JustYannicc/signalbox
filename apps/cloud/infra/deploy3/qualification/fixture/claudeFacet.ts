// @effect-diagnostics cryptoRandomUUID:off - Snapshot IDs are local qualification evidence.
import { restoreFacetCheckpoint, facetCheckpointLineage } from "./checkpointLineage.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import { HarnessRequestFacetError } from "../../../../src/harness/HarnessRequestFacet.ts";
import { createHarnessCProductClaudeFacetClass } from "../../../../src/harness/ProductClaudeHarnessRequestFacet.ts";
import { samePreparedRelease } from "../../../../src/harness/ProductHarnessProcessRelease.ts";
import { assert } from "./common.ts";
import { turnBindings } from "./facetBindings.ts";
import {
  buildClaudeFacetHostOptions,
  claudeCapability,
  claudeConfiguration,
  type ClaudeFacetEnvironment,
} from "./claudeHostOptions.ts";
import {
  readClaudeQualificationInputs,
  loadClaudeQualificationRuntime,
} from "./claudeConfiguration.ts";
import { calibrateClaudePreparedRelease } from "./claudeCalibration.ts";
import { decodePreparedRelease } from "../preparedRelease.schema.ts";

export const CLAUDE_QUALIFICATION_ENTRYPOINT = "ClaudeFacet" as const;

type Env = ClaudeFacetEnvironment;
const decodeTurn = Schema.decodeSync(Schema.fromJsonString(Schema.toCodecJson(RunnerTurn)));

const Base = createHarnessCProductClaudeFacetClass<Env, unknown>({
  buildHostOptions: (input) =>
    Effect.gen(function* () {
      restoreFacetCheckpoint(input.ctx, input.filesCheckpoint.checkpoint.checkpointId);
      return yield* buildClaudeFacetHostOptions(input);
    }),
  buildOpenInput: ({ env, nativeSessionId }) =>
    Effect.tryPromise({
      try: async () => {
        const { claude } = await claudeConfiguration(env);
        const turn = decodeTurn(claude.turnJson[0]!);
        return {
          session: {
            threadId: turn.threadId,
            providerSessionId: turn.providerThread.providerSessionId!,
            modelSelection: turn.modelSelection,
            runtimePolicy: {
              cwd: claude.seed.cwd,
              runtimeMode: "full-access" as const,
              interactionMode: "default" as const,
            },
            initialNativeThreadId: nativeSessionId,
          },
          bootAttemptId: "claude-restored-product-open",
        };
      },
      catch: (cause) =>
        new HarnessRequestFacetError("Claude open input could not be built.", { cause }),
    }),
  fresh: {
    buildHostOptions: buildClaudeFacetHostOptions,
    buildOpenInput: ({ env, operationId }) =>
      Effect.tryPromise({
        try: async () => {
          const { claude } = await claudeConfiguration(env);
          const turn = decodeTurn(claude.turnJson[0]!);
          assert(
            turn.providerThread.nativeThreadRef === null,
            "Fresh Claude template must be unbound",
          );
          return {
            session: {
              threadId: turn.threadId,
              providerSessionId: turn.providerThread.providerSessionId!,
              modelSelection: turn.modelSelection,
              runtimePolicy: {
                cwd: claude.seed.cwd,
                runtimeMode: "full-access" as const,
                interactionMode: "default" as const,
              },
            },
            creation: { providerThread: turn.providerThread },
            bootAttemptId: operationId,
          };
        },
        catch: (cause) =>
          new HarnessRequestFacetError("Fresh Claude open input could not be built.", { cause }),
      }),
  },
  buildTurnBindings: ({ env, ctx }) =>
    Effect.succeed(turnBindings(ctx, claudeCapability(env), facetCheckpointLineage(ctx))),
});

export class ClaudeFacet extends Base {
  override async loadedPreparedRelease() {
    const loaded = decodePreparedRelease(await super.loadedPreparedRelease());
    const expected = this.env.HARNESS_C_TARGET_PREPARED_RELEASE;
    assert(
      expected && samePreparedRelease(loaded, expected),
      "Loaded Claude artifact identity differs from C's selected prepared release",
    );
    const loadedArtifact = await claudeCapability(this.env).recordClaudeLoadedRelease(
      this.facetNonce,
      loaded,
    );
    const encoded = new TextEncoder().encode(JSON.stringify(loaded));
    const digest = await crypto.subtle.digest("SHA-256", encoded.slice().buffer);
    const preparedIdentitySha256 = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    await claudeCapability(this.env).append("claude-loaded-prepared-release", {
      incarnation: this.facetNonce,
      loadedArtifact,
      artifact: loaded.artifact,
      plan: {
        release: loaded.plan.release,
        sourceIdentity: loaded.plan.sourceIdentity,
        computer: loaded.plan.computer,
        preparedModuleCount: Object.keys(loaded.plan.preparedModules).length,
        preparedIdentitySha256,
      },
    });
    return loaded;
  }

  async observerCalibration(input: { readonly invocationId: string }) {
    const { claude } = await claudeConfiguration(this.env);
    const release = this.env.HARNESS_C_TARGET_PREPARED_RELEASE;
    assert(
      release?.artifact.provider === "claude-code",
      "Calibration has no selected Claude release",
    );
    const qualification = await readClaudeQualificationInputs(claude, this.env.PROGRAM_ASSETS!);
    const loaded = await loadClaudeQualificationRuntime(qualification, release.artifact);
    const imported = await calibrateClaudePreparedRelease({
      ctx: this.ctx,
      capability: claudeCapability(this.env),
      release: loaded,
      home: claude.seed.home,
    });
    const result = {
      incarnation: this.facetNonce,
      invocationId: input.invocationId,
      selectedReleaseId: release.artifact.releaseId,
      selectedReleaseHash: release.artifact.artifactHash,
      imported,
      nativeStarted: false as const,
    };
    await claudeCapability(this.env).append("claude-prepared-import-calibration", result);
    return result;
  }
}
