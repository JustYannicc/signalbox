import type { Configuration } from "./configuration.ts";
import { claudeLane, type ClaudeVariant } from "./claudeCTransport.ts";
import {
  control,
  publisherKey,
  requestPublisherKey,
  RUN_CONTROL_KEY,
  supervisor,
} from "./common.ts";
import type {
  HarnessRunArtifact,
  HarnessRequestOffer,
} from "../../../../src/harness/HarnessRunStore.ts";
import type { HarnessThreadSupervisorPublisher } from "../../../../src/harness/HarnessThreadSupervisor.ts";
import type { HarnessProcessCreationInput } from "../../../../src/harness/HarnessProcessCreation.ts";
import type { HarnessProcessResumeOperationInput } from "../../../../src/harness/HarnessProcessResume.ts";
import type { ClaudeCTransport } from "./claudeCTransport.ts";
import { claudeBootstrap, claudeFacet } from "./claudeFacetInputs.ts";
export { claudeBootstrap, claudeFacet } from "./claudeFacetInputs.ts";

export type ClaudeCreated = Awaited<ReturnType<ClaudeCTransport["startFreshProcess"]>>;
export function claudeCreationInput(
  config: Configuration,
  variant: ClaudeVariant,
  seed: HarnessRunArtifact,
): HarnessProcessCreationInput {
  const lane = claudeLane(config.runId, variant);
  return {
    runId: lane.runId,
    operationId: lane.creationOperationId,
    run: {
      type: "initialize",
      seed: {
        identity: {
          runId: lane.runId,
          hostId: "combined-claude-qualifier",
          threadId: lane.processId,
          logicalTurnId: "three-turns-one-replacement",
          filesystemId: lane.processId,
        },
        locator: seed,
        config: seed,
        artifacts: [seed],
      },
      controlKey: RUN_CONTROL_KEY,
      supervisorKey: supervisor.supervisorKey,
      claimId: supervisor.claimId,
      requestId: `${variant}-initialize`,
    },
    controllerClaim: control(1),
    publisherKey: publisherKey(1),
    requestPublisherKey: requestPublisherKey(1),
    requestModeId: `${variant}-request-mode`,
    facet: {
      ...claudeFacet(config, variant),
      productBootstrap: claudeBootstrap(config, variant),
      targetPreparedRelease: config.claude.expected[variant],
    },
  };
}
export function claudeReplacementInput(input: {
  readonly config: Configuration;
  readonly variant: ClaudeVariant;
  readonly created: ClaudeCreated;
  readonly firstRequest: HarnessRequestOffer;
  readonly requestPublisher: HarnessThreadSupervisorPublisher;
  readonly publisher: HarnessThreadSupervisorPublisher;
}): HarnessProcessResumeOperationInput {
  const { config, variant } = input;
  const lane = claudeLane(config.runId, variant);
  return {
    runId: lane.runId,
    previousProcessId: lane.processId,
    previousOperationId: lane.creationOperationId,
    previousStepId: input.firstRequest.requestId,
    runStore: {
      runId: lane.runId,
      processId: lane.processId,
      processOperationId: lane.creationOperationId,
      transitionOperationId: lane.resumeOperationId,
      controlKey: RUN_CONTROL_KEY,
      supervisor,
      currentPublisher: input.requestPublisher,
      nextPublisherKey: requestPublisherKey(2),
      request: input.firstRequest,
      checkpoint: input.created.checkpoint,
    },
    transition: {
      operationId: lane.resumeOperationId,
      control: control(1),
      publisher: input.publisher,
      nextControl: control(2),
      expectedFacetGeneration: input.publisher.generation,
      targetPreparedRelease: config.claude.expected[variant],
    },
    facet: claudeFacet(config, variant),
    productBootstrap: claudeBootstrap(config, variant),
  };
}
