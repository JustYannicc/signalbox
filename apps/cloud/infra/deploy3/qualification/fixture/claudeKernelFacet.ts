// @effect-diagnostics cryptoRandomUUID:off - This owner exists before the host's Effect runtime.
import * as Schema from "effect/Schema";
import { RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import { createClaudeKernelFacetClass } from "../../../../src/harness/ClaudeKernelSession.ts";
import {
  KernelFileTransfer,
  kernelFileTransferManifest,
} from "../../../../src/kernel/KernelFileTransfer.ts";
import { createMemoryFilePersistencePorts } from "../../../../src/kernel/MemoryFilePersistencePorts.ts";
import { hydrateClaudeFiles } from "./claudeFiles.ts";
import { claudeSeedPaths } from "./claudeSeed.ts";
import { facetState, retainedFacetState, flushFacetDiagnostics } from "./facetState.ts";
import {
  claudeCapability,
  claudeOwnerConfiguration,
  type ClaudeOwnerEnvironment,
} from "./claudeRuntimeEnvironment.ts";
import { capture } from "./snapshot.ts";
import { assert } from "./common.ts";

const decodeTurn = Schema.decodeSync(Schema.fromJsonString(Schema.toCodecJson(RunnerTurn)));
const Base = createClaudeKernelFacetClass<ClaudeOwnerEnvironment>(
  async ({ ctx, env, configuration }) => {
    const { claude, host } = await claudeOwnerConfiguration(env);
    const turn = decodeTurn(claude.turnJson[0]!);
    assert(configuration.threadId === turn.threadId, "CLI kernel changed thread owner");
    const cap = claudeCapability(env);
    const state = facetState(ctx, cap, configuration.sessionKey);
    const paths = claudeSeedPaths(claude.seed);
    return {
      files: {
        database: state.files.database,
        nowNs: state.files.nowNs,
        persistencePorts: createMemoryFilePersistencePorts(),
      },
      machine: () => ({
        files: {
          current: () => ({
            generation: null,
            generationAbsent: true as const,
            pristine: true,
            imageDigest: host.imageDigest,
          }),
          markExecuted: async () => {
            throw new Error("Claude qualifier has no machine generation");
          },
          lookup: async () => {
            throw new Error("Claude qualifier excludes live machine file access");
          },
        },
        spawn: async () => {
          throw new Error("Claude qualifier excludes machine command forwarding");
        },
      }),
      hydrate: async ({ files, restored, loaded }) => {
        const selected = env.HARNESS_C_TARGET_PREPARED_RELEASE;
        assert(selected, "CLI kernel selected release is missing");
        await hydrateClaudeFiles({
          state,
          cap,
          paths,
          turn,
          restored,
          nativeSessionId: configuration.nativeSessionId,
          incarnation: configuration.sessionKey,
          preparedModuleCount: Object.keys(loaded.plan.preparedModules).length,
          artifactHash: selected.artifact.artifactHash,
        })({ files });
      },
      observeInput: (bytes) => state.raw("native-stdin", bytes),
      observeOutput: (fd, bytes) => state.raw(fd === 1 ? "native-stdout" : "native-stderr", bytes),
      save: async () => ({ commit: `claude-snapshot-${configuration.sessionKey}` }),
      port: async () => {
        throw new Error("Claude qualifier excludes network ports");
      },
    };
  },
);

/** Computer owns the sole kernel; the official CLI runs in its separate facet. */
export class ClaudeKernelFacet extends Base {
  readonly facetNonce = crypto.randomUUID();
  identity() {
    return { facetNonce: this.facetNonce };
  }
  async checkpointFiles() {
    const state = retainedFacetState(this.ctx);
    await state.flush();
    const files = capture(state.files, state.threadId, state.boundFiles);
    return {
      manifest: kernelFileTransferManifest(files),
      source: new KernelFileTransfer(files),
      rawCounts: [...state.rawOrdinals],
    };
  }
  async flushDiagnostics(reason: "checkpoint" | "request-settled" | "disposed") {
    await flushFacetDiagnostics(this.ctx, reason);
  }
}
