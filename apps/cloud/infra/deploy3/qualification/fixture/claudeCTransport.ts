import type { HarnessProcessExecutionShardObject } from "../../../../src/harness/HarnessProcessExecutionShardObject.ts";
import type { Configuration } from "./configuration.ts";
import type { HarnessProcessExecutionShardInput } from "../../../../src/harness/HarnessProcessPlacement.ts";
import type { HarnessProcessResumeOperationInput } from "../../../../src/harness/HarnessProcessResume.ts";
import type {
  HarnessProcessContinuationInput,
  HarnessProcessCheckpointInput,
} from "../../../../src/harness/HarnessProcessResume.ts";
import type {
  HarnessCProductBootstrapDescriptor,
  HarnessProcessResumeFacetCode,
} from "../../../../src/harness/HarnessProcessResume.ts";
import type { HarnessProcessResumePreparedRelease } from "../../../../src/harness/HarnessProcessResume.ts";
import { samePreparedRelease } from "../../../../src/harness/ProductHarnessProcessRelease.ts";
import {
  NATIVE_SESSION_UUID,
  type HarnessProcessCreationInput,
  type HarnessProcessCreationRunInput,
} from "../../../../src/harness/HarnessProcessCreation.ts";
import { sameData } from "../../../../src/harness/HarnessProcessResume.ts";
import { assert } from "./common.ts";

export type { ClaudeVariant, ClaudeStepPhase, ClaudeStep } from "./claudeScenario.ts";
import type { ClaudeVariant, ClaudeStepPhase, ClaudeStep } from "./claudeScenario.ts";

export type ClaudeCShard = Pick<
  HarnessProcessExecutionShardObject,
  | "startFreshProcess"
  | "runCreatedProcess"
  | "processCreationStatus"
  | "runShard"
  | "resumeProcess"
  | "continueProcess"
  | "commitProcessCheckpoint"
  | "stopIdleProcess"
>;
export interface ClaudeCTransportOptions {
  readonly variant: ClaudeVariant;
  readonly configuration: () => Promise<Pick<Configuration, "runId" | "claude">>;
  readonly shard: () => ClaudeCShard;
  readonly phaseForRequest: (requestId: string) => ClaudeStepPhase;
  readonly beginStep: (step: ClaudeStep) => Promise<unknown>;
  readonly endStep: (step: ClaudeStep) => Promise<unknown>;
}

export const claudeLane = (rootRunId: string, variant: ClaudeVariant) => {
  const runId = `${rootRunId}/claude/${variant}`;
  return {
    runId,
    shardOwner: `combined/${runId}`,
    processId: `official-claude-${variant}`,
    creationOperationId: `claude-${variant}-create`,
    resumeOperationId: `claude-${variant}-replace`,
  };
};
const MAIN = "qualifier-claude-facet.mjs";
const MODULES = {
  [MAIN]: { js: "export { ClaudeFacet } from './qualifier-claude-implementation.mjs';\n" },
};

/** Sends requests to C's normal durable owner; it never creates a facet or native runtime. */
export function createClaudeCTransport(options: ClaudeCTransportOptions) {
  const selected = async () => {
    const config = await options.configuration();
    assert(
      config.claude.runtime.purpose === "qualification",
      "Claude C transport requires qualification assets",
    );
    const release = config.claude.expected[options.variant];
    assert(
      release.artifact.provider === "claude-code",
      "Claude C transport selected another provider",
    );
    return { ...claudeLane(config.runId, options.variant), release };
  };
  const checkFacet = (
    facet: HarnessProcessResumeFacetCode,
    descriptor: HarnessCProductBootstrapDescriptor | undefined,
    release: HarnessProcessResumePreparedRelease | undefined,
    expected: Awaited<ReturnType<typeof selected>>,
  ) => {
    assert(
      descriptor?.provider === "claude-code" &&
        descriptor.restoreMode === "same-variant-serialized-checkpoint" &&
        descriptor.preparedReleaseId === expected.release.artifact.releaseId &&
        release &&
        samePreparedRelease(release, expected.release),
      "Claude C transport release differs from the selected qualification variant",
    );
    assert(
      facet.processId === expected.processId &&
        facet.codeId === expected.release.artifact.releaseId &&
        facet.mainModule === MAIN &&
        facet.entrypoint === "ClaudeFacet" &&
        sameData(facet.modules, MODULES),
      "Claude C transport requires the normal compiled product facet",
    );
  };
  const bracket = async <A>(requestId: string, invoke: () => Promise<A>) => {
    const step = { variant: options.variant, requestId, phase: options.phaseForRequest(requestId) };
    await options.beginStep(step);
    try {
      return await invoke();
    } finally {
      await options.endStep(step);
    }
  };
  return {
    async startFreshProcess(input: HarnessProcessCreationInput) {
      const expected = await selected();
      assert(
        input.runId === expected.runId &&
          input.operationId === expected.creationOperationId &&
          input.run.seed.identity.runId === expected.runId,
        "Claude fresh creation belongs to another lane",
      );
      checkFacet(
        input.facet,
        input.facet.productBootstrap,
        input.facet.targetPreparedRelease,
        expected,
      );
      assert(
        input.facet.facetEnv?.QUALIFIER_CLAUDE_VARIANT === options.variant,
        "Claude fresh creation variant label changed",
      );
      return await bracket(`${options.variant}-create`, () =>
        options.shard().startFreshProcess(input),
      );
    },
    async runCreatedProcess(input: HarnessProcessCreationRunInput, requestContextId: string) {
      const expected = await selected();
      assert(
        input.runId === expected.runId &&
          input.operationId === expected.creationOperationId &&
          input.request.requestId === requestContextId,
        "Claude fresh request belongs to another lane",
      );
      return await bracket(requestContextId, () =>
        options.shard().runCreatedProcess(input, requestContextId),
      );
    },
    async processCreationStatus(...args: Parameters<ClaudeCShard["processCreationStatus"]>) {
      const expected = await selected();
      assert(args[0].runId === expected.runId, "Claude creation status belongs to another lane");
      return await options.shard().processCreationStatus(...args);
    },
    async runShard(input: HarnessProcessExecutionShardInput, requestContextId: string) {
      const expected = await selected();
      assert(
        input.runId === expected.runId &&
          input.shardOwner === expected.shardOwner &&
          input.executionMode === "native-journal" &&
          input.processes.length === 1,
        "Claude C transport requires its one real native-journal lane",
      );
      const process = input.processes[0]!;
      checkFacet(process, process.productBootstrap, process.targetPreparedRelease, expected);
      assert(
        process.facetEnv?.QUALIFIER_CLAUDE_VARIANT === options.variant &&
          NATIVE_SESSION_UUID.test(process.nativeSessionId) &&
          process.journal &&
          process.journal.runStore.runId === expected.runId &&
          process.journal.runStore.processId === expected.processId &&
          process.journal.runStore.request.requestId === requestContextId,
        "Claude C transport requires a real native checkpoint and request authority",
      );
      return await bracket(requestContextId, () =>
        options.shard().runShard(input, requestContextId),
      );
    },
    async resumeProcess(input: HarnessProcessResumeOperationInput) {
      const expected = await selected();
      assert(
        input.runId === expected.runId &&
          input.previousProcessId === expected.processId &&
          input.runStore.runId === expected.runId &&
          input.runStore.processId === expected.processId,
        "Claude C resume belongs to another lane",
      );
      checkFacet(
        input.facet,
        input.productBootstrap,
        input.transition.targetPreparedRelease,
        expected,
      );
      return await bracket(`${options.variant}-replace`, () =>
        options.shard().resumeProcess(input),
      );
    },
    async continueProcess(input: HarnessProcessContinuationInput, requestContextId: string) {
      const expected = await selected();
      assert(
        input.runId === expected.runId &&
          input.processId === expected.processId &&
          input.runStore.request.requestId === requestContextId,
        "Claude C continuation belongs to another lane or request",
      );
      return await bracket(requestContextId, () =>
        options.shard().continueProcess(input, requestContextId),
      );
    },
    async commitProcessCheckpoint(input: HarnessProcessCheckpointInput) {
      const expected = await selected();
      assert(
        input.runId === expected.runId && input.processId === expected.processId,
        "Claude C checkpoint belongs to another lane",
      );
      return await options.shard().commitProcessCheckpoint(input);
    },
    async stopIdleProcess(input: HarnessProcessContinuationInput) {
      const expected = await selected();
      assert(
        input.runId === expected.runId && input.processId === expected.processId,
        "Claude C stop belongs to another lane",
      );
      return await bracket(`${options.variant}-stop`, () => options.shard().stopIdleProcess(input));
    },
  };
}

export type ClaudeCTransport = ReturnType<typeof createClaudeCTransport>;
