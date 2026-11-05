// @effect-diagnostics cryptoRandomUUID:off - This owner exists before the host's Effect runtime.
import * as Schema from "effect/Schema";
import { RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import { createClaudeKernelFacetClass } from "../../../../src/harness/ClaudeKernelSession.ts";
import { DEFAULT_NODE_NATIVE_MODULES } from "../../../../src/harness/NodeNativeModules.ts";
import {
  KernelFileTransfer,
  kernelFileTransferManifest,
} from "../../../../src/kernel/KernelFileTransfer.ts";
import { createMemoryFilePersistencePorts } from "../../../../src/kernel/MemoryFilePersistencePorts.ts";
import { createClaudePreparedImports } from "./claudePreparedModules.ts";
import { hydrateClaudeFiles } from "./claudeFiles.ts";
import { claudeSeedPaths } from "./claudeSeed.ts";
import { facetState, retainedFacetState, flushFacetDiagnostics } from "./facetState.ts";
import {
  claudeCapability,
  claudeConfiguration,
  type ClaudeFacetEnvironment,
} from "./claudeRuntimeEnvironment.ts";
import { capture } from "./snapshot.ts";
import { assert } from "./common.ts";

const decodeTurn = Schema.decodeSync(Schema.fromJsonString(Schema.toCodecJson(RunnerTurn)));
const Base = createClaudeKernelFacetClass<ClaudeFacetEnvironment>(
  async ({ ctx, env, configuration }) => {
    const { claude, host } = await claudeConfiguration(env);
    const turn = decodeTurn(claude.turnJson[0]!);
    assert(configuration.threadId === turn.threadId, "CLI kernel changed thread owner");
    const cap = claudeCapability(env);
    const state = facetState(ctx, cap, configuration.sessionKey);
    const imports = createClaudePreparedImports();
    const paths = claudeSeedPaths(claude.seed);
    return {
      files: {
        database: state.files.database,
        nowNs: state.files.nowNs,
        persistencePorts: createMemoryFilePersistencePorts(),
      },
      native: (loaded) => {
        assert(loaded.plan.harness === "claude-code", "CLI kernel selected another provider");
        const plan = loaded.plan;
        return {
          nativeModules: DEFAULT_NODE_NATIVE_MODULES,
          loadPackages: async (_bridge, signal) => await imports.loadPackages(plan, signal),
          loadRelease: async (_bridge, signal) => await imports.loadRelease(plan, signal),
        };
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

/** This bundle has the official CLI and its one synchronous kernel, with no Computer or host orchestration. */
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
