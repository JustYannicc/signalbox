import { readRpcData } from "../../../../src/rpc/Resources.ts";
import type { RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import type { HarnessFilesStoreResult } from "../../../../src/harness/HarnessFilesStore.ts";
import type { KernelFileSystem } from "../../../../src/kernel/KernelFileSystem.ts";
import { createNodeFs } from "../../../../src/isolate/NodeFs.ts";
import type { FacetState } from "./facetState.ts";
import type { QualifierCapabilities } from "./capabilities.ts";
import { compareBeforeReadiness } from "./snapshot.ts";
import { prepareClaudeSeed, type ClaudeSeedPaths } from "./claudeSeed.ts";
import { assert } from "./common.ts";

/** Fresh creation builds directories; restore verifies the exact completed-checkpoint bytes first. */
export const hydrateClaudeFiles =
  (input: {
    readonly state: FacetState;
    readonly cap: Pick<QualifierCapabilities, "append">;
    readonly paths: ClaudeSeedPaths;
    readonly turn: RunnerTurn;
    readonly restored: HarnessFilesStoreResult["files"] | undefined;
    readonly nativeSessionId: string | null | undefined;
    readonly incarnation: string;
    readonly preparedModuleCount: number;
    readonly artifactHash: string;
  }) =>
  async ({ files }: { readonly files: KernelFileSystem }) => {
    const { state, cap, paths, turn, restored, nativeSessionId } = input;
    state.boundFiles = files;
    state.threadId = turn.threadId;
    const proof =
      restored === undefined ? undefined : await compareBeforeReadiness(files, restored);
    for (const entry of restored ?? [])
      if (entry.kind !== "symlink")
        state.reads.register(entry.path, files.resolve(`/workspace/${entry.path}`).inode);
    state.reads.phase("repository-readiness");
    if (restored !== undefined) {
      assert(nativeSessionId, "Restored Claude session identity is missing");
      prepareClaudeSeed(files, paths, nativeSessionId);
    } else {
      const fs = createNodeFs(files).fs;
      fs.mkdirSync(paths.cwd, { recursive: true });
      fs.mkdirSync(paths.home, { recursive: true });
      fs.mkdirSync(paths.projectState, { recursive: true });
    }
    await readRpcData(
      cap.append("claude-files-before-readiness", {
        incarnation: input.incarnation,
        restored: restored !== undefined,
        proof,
        preparedModuleCount: input.preparedModuleCount,
        artifactHash: input.artifactHash,
      }),
    );
  };
