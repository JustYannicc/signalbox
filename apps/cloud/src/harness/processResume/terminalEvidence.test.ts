import { describe, expect, it } from "@effect/vitest";
import type { HarnessDurableState } from "../HarnessDurableState.ts";
import type { HarnessProcessHandle } from "../HarnessProcessPlacement.ts";
import type { HarnessProcessFacetInvokeInput } from "../HarnessProcessFacet.ts";
import type { HarnessProcessExecutionProcessInput } from "../processPlacement/execution.ts";
import type { HarnessProcessResumeInput, HarnessProcessResumeOperationInput } from "./contracts.ts";
import { persistTerminalEvidence } from "./terminalEvidence.ts";

const control = {
  ownerId: "resume-owner",
  incarnationId: "resume-incarnation",
  epoch: 9,
  controlKey: "next-control-key",
};
const publisher = {
  generation: 4,
  facetNonce: "old-facet",
  publisherKey: "old-publisher-key",
};

const process: HarnessProcessExecutionProcessInput = {
  processId: "old-process",
  codeId: "old-code",
  residentBytes: 1,
  nativeSessionId: "native-session",
  checkpointId: "checkpoint-before",
  manifestRevision: "manifest-before",
  operationId: "old-operation",
  priorFacetNonce: "prior-facet",
  expectedFacetGeneration: 3,
  mainModule: "main",
  modules: { main: "export default {}" },
  entrypoint: "Process",
};

const operation = {
  runId: "run-resume",
  previousProcessId: process.processId,
  previousOperationId: process.operationId,
  previousStepId: "step-1",
  transition: {
    operationId: "resume-operation",
    control: { ...control, incarnationId: "previous-incarnation", epoch: 8 },
    nextControl: control,
    publisher,
    expectedFacetGeneration: publisher.generation,
    targetPreparedRelease: {} as HarnessProcessResumeInput["targetPreparedRelease"],
  },
  facet: {} as HarnessProcessResumeOperationInput["facet"],
} as HarnessProcessResumeOperationInput;

describe("process resume terminal evidence", () => {
  it("records stop and joined settlement before placement may release the old lease", async () => {
    const events: string[] = [];
    let stopAcknowledgementId: string | null = null;
    let outcome: "stopped" | "indeterminate" | undefined;
    const checkpoint = {
      checkpointId: "checkpoint-after",
      manifestSha256: "manifest-after",
    };
    const snapshot = () => ({
      ownerId: control.ownerId,
      controlIncarnationId: control.incarnationId,
      controlEpoch: control.epoch,
      nativeSessionId: "native-session",
      checkpoint,
      generation: publisher.generation,
      facetNonce: publisher.facetNonce,
      lifecycle: outcome === "stopped" ? "stopped" : "draining",
      admittedStepId: null,
      stopAcknowledgementId,
      settlement:
        outcome === undefined
          ? null
          : {
              outcome,
              invocationRpcJoined: true,
              fetchJoined: true,
              callbackPortsJoined: true,
            },
    });
    const durable = {
      threadSupervisor: {
        async execute(command: { readonly type: string; readonly [key: string]: unknown }) {
          events.push(`supervisor:${command.type}`);
          if (command.type === "recordStopAcknowledgement")
            stopAcknowledgementId = command.acknowledgementId as string;
          if (command.type === "settleInvocation") outcome = command.outcome as typeof outcome;
          return {
            snapshot: snapshot(),
            currentPublisher: publisher,
          };
        },
      },
      runStore: {
        async execute() {
          events.push("journal:read");
          return {
            snapshot: {
              requests: {
                entries: [
                  {
                    request: { requestId: "step-1" },
                    status: "completed",
                    finish: { status: "completed" },
                  },
                ],
              },
            },
          };
        },
      },
    } as unknown as HarnessDurableState;
    const handle = {
      identity: {
        shardOwner: "shard-owner",
        loaderId: "old-loader",
        facetKey: "old-loader",
        incarnationNonce: "old-facet",
      },
      async stop() {
        events.push("facet:stop");
        return { acknowledged: true };
      },
      async join() {
        events.push("facet:join");
        return { invocationRpc: true, fetch: true, ports: true };
      },
    } as unknown as HarnessProcessHandle<HarnessProcessFacetInvokeInput>;
    const preDrain = {
      lifecycle: "accepting",
      admittedStepId: "step-1",
      checkpoint: {
        checkpointId: "checkpoint-before",
        manifestSha256: "manifest-before",
      },
      nativeSessionId: "native-session",
      generation: publisher.generation,
      facetNonce: publisher.facetNonce,
      controlEpoch: 8,
      controlIncarnationId: "previous-incarnation",
    };

    const result = await persistTerminalEvidence({
      durable,
      transition: operation.transition,
      operation,
      previousProcess: process,
      preDrain,
      requestId: "step-1",
      handle,
    });

    expect(result).toEqual({
      _tag: "committed",
      checkpoint: {
        ...checkpoint,
        nativeSessionId: "native-session",
      },
    });
    expect(events).toEqual([
      "supervisor:read",
      "facet:stop",
      "facet:join",
      "journal:read",
      "supervisor:recordStopAcknowledgement",
      "supervisor:settleInvocation",
      "supervisor:read",
    ]);
  });
});
