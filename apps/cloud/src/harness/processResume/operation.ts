import type {
  HarnessProcessResumeFacetCode,
  HarnessProcessResumeOperationInput,
} from "./contracts.ts";
import { snapshotHarnessProcessResumeRunStoreBinding } from "./runStoreBinding.ts";
import { samePreparedRelease, snapshotInput } from "./identity.ts";
import {
  snapshotHarnessProcessModules,
  sameHarnessProcessModules,
} from "../processPlacement/moduleCode.ts";

const text = (value: unknown, maximum = 256): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;

function snapshotProductBootstrap(
  value: unknown,
  target: HarnessProcessResumeOperationInput["transition"]["targetPreparedRelease"],
): HarnessProcessResumeOperationInput["productBootstrap"] | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;

    const descriptor = value as Record<string, unknown>;
    const keys = Reflect.ownKeys(descriptor);
    if (
      keys.length !== 3 ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          (key !== "provider" && key !== "preparedReleaseId" && key !== "restoreMode"),
      )
    )
      return undefined;

    const provider = descriptor.provider;
    const preparedReleaseId = descriptor.preparedReleaseId;
    const restoreMode = descriptor.restoreMode;
    if (
      (provider !== "claude-code" && provider !== "codex") ||
      typeof preparedReleaseId !== "string" ||
      preparedReleaseId.trim().length === 0 ||
      (restoreMode !== "same-variant-serialized-checkpoint" &&
        restoreMode !== "cross-variant-fresh-boot") ||
      provider !== target.artifact.provider ||
      preparedReleaseId !== target.artifact.releaseId
    )
      return undefined;

    return Object.freeze({ provider, preparedReleaseId, restoreMode });
  } catch {
    return undefined;
  }
}

function snapshotFacetCode(value: unknown): HarnessProcessResumeFacetCode | undefined {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const facet = value as Record<string, unknown>;
    if (
      !text(facet.processId) ||
      !text(facet.codeId) ||
      !Number.isSafeInteger(facet.residentBytes) ||
      (facet.residentBytes as number) <= 0 ||
      !text(facet.mainModule) ||
      !text(facet.entrypoint) ||
      typeof facet.modules !== "object" ||
      facet.modules === null ||
      Array.isArray(facet.modules)
    )
      return undefined;

    const modules = snapshotHarnessProcessModules(facet.modules, facet.mainModule);
    if (modules === undefined) return undefined;
    return Object.freeze({
      processId: facet.processId,
      codeId: facet.codeId,
      residentBytes: facet.residentBytes as number,
      mainModule: facet.mainModule,
      modules,
      entrypoint: facet.entrypoint,
    });
  } catch {
    return undefined;
  }
}

/** Copies the serializable request before any await and rejects extra authority fields. */
export function snapshotHarnessProcessResumeOperation(
  value: unknown,
): HarnessProcessResumeOperationInput | undefined {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const supplied = value as Record<string, unknown>;
    if (
      Reflect.ownKeys(supplied).some(
        (key) =>
          typeof key !== "string" ||
          (key !== "runId" &&
            key !== "previousProcessId" &&
            key !== "previousOperationId" &&
            key !== "previousStepId" &&
            key !== "runStore" &&
            key !== "transition" &&
            key !== "facet" &&
            key !== "productBootstrap"),
      ) ||
      !text(supplied.runId) ||
      !text(supplied.previousProcessId) ||
      !text(supplied.previousOperationId) ||
      !text(supplied.previousStepId)
    )
      return undefined;

    const runStore = snapshotHarnessProcessResumeRunStoreBinding(supplied.runStore);
    const transition = snapshotInput(
      supplied.transition as HarnessProcessResumeOperationInput["transition"],
    );
    const facet = snapshotFacetCode(supplied.facet);
    if (runStore === undefined || transition === undefined || facet === undefined) return undefined;
    const productBootstrap = snapshotProductBootstrap(
      supplied.productBootstrap,
      transition.targetPreparedRelease,
    );
    if (productBootstrap === undefined) return undefined;
    if (
      runStore.runId !== supplied.runId ||
      runStore.processId !== supplied.previousProcessId ||
      runStore.processOperationId !== supplied.previousOperationId ||
      runStore.transitionOperationId !== transition.operationId ||
      runStore.request.requestId !== supplied.previousStepId ||
      facet.processId !== supplied.previousProcessId ||
      runStore.currentPublisher.generation !== transition.expectedFacetGeneration ||
      runStore.currentPublisher.generation !== transition.publisher.generation ||
      runStore.currentPublisher.facetNonce !== transition.publisher.facetNonce
    )
      return undefined;

    return Object.freeze({
      runId: supplied.runId,
      previousProcessId: supplied.previousProcessId,
      previousOperationId: supplied.previousOperationId,
      previousStepId: supplied.previousStepId,
      runStore,
      transition,
      facet,
      productBootstrap,
    });
  } catch {
    return undefined;
  }
}

/** A duplicate operation is equal by fields, independent of record insertion order. */
export function sameHarnessProcessResumeOperation(
  left: HarnessProcessResumeOperationInput,
  right: HarnessProcessResumeOperationInput,
): boolean {
  const sameControl = (a: typeof left.transition.control, b: typeof right.transition.control) =>
    a.ownerId === b.ownerId &&
    a.incarnationId === b.incarnationId &&
    a.epoch === b.epoch &&
    a.controlKey === b.controlKey;
  const samePublisher = (
    a: typeof left.transition.publisher,
    b: typeof right.transition.publisher,
  ) =>
    a.generation === b.generation &&
    a.facetNonce === b.facetNonce &&
    a.publisherKey === b.publisherKey;
  const sameArtifact = (
    a: HarnessProcessResumeOperationInput["runStore"]["request"]["input"],
    b: HarnessProcessResumeOperationInput["runStore"]["request"]["input"],
  ) => a.id === b.id && a.sha256 === b.sha256 && a.bytes === b.bytes;
  return (
    left.runId === right.runId &&
    left.previousProcessId === right.previousProcessId &&
    left.previousOperationId === right.previousOperationId &&
    left.previousStepId === right.previousStepId &&
    left.runStore.runId === right.runStore.runId &&
    left.runStore.processId === right.runStore.processId &&
    left.runStore.processOperationId === right.runStore.processOperationId &&
    left.runStore.transitionOperationId === right.runStore.transitionOperationId &&
    left.runStore.controlKey === right.runStore.controlKey &&
    left.runStore.supervisor.supervisorKey === right.runStore.supervisor.supervisorKey &&
    left.runStore.supervisor.epoch === right.runStore.supervisor.epoch &&
    left.runStore.supervisor.claimId === right.runStore.supervisor.claimId &&
    left.runStore.currentPublisher.generation === right.runStore.currentPublisher.generation &&
    left.runStore.currentPublisher.facetNonce === right.runStore.currentPublisher.facetNonce &&
    left.runStore.currentPublisher.publisherKey === right.runStore.currentPublisher.publisherKey &&
    left.runStore.nextPublisherKey === right.runStore.nextPublisherKey &&
    left.runStore.request.requestId === right.runStore.request.requestId &&
    sameArtifact(left.runStore.request.input, right.runStore.request.input) &&
    left.runStore.checkpoint.native.id === right.runStore.checkpoint.native.id &&
    left.runStore.checkpoint.native.sha256 === right.runStore.checkpoint.native.sha256 &&
    left.runStore.checkpoint.native.bytes === right.runStore.checkpoint.native.bytes &&
    left.runStore.checkpoint.filesystem.id === right.runStore.checkpoint.filesystem.id &&
    left.runStore.checkpoint.filesystem.sha256 === right.runStore.checkpoint.filesystem.sha256 &&
    left.runStore.checkpoint.filesystem.bytes === right.runStore.checkpoint.filesystem.bytes &&
    left.transition.operationId === right.transition.operationId &&
    sameControl(left.transition.control, right.transition.control) &&
    samePublisher(left.transition.publisher, right.transition.publisher) &&
    sameControl(left.transition.nextControl, right.transition.nextControl) &&
    left.transition.expectedFacetGeneration === right.transition.expectedFacetGeneration &&
    samePreparedRelease(
      left.transition.targetPreparedRelease,
      right.transition.targetPreparedRelease,
    ) &&
    left.productBootstrap.provider === right.productBootstrap.provider &&
    left.productBootstrap.preparedReleaseId === right.productBootstrap.preparedReleaseId &&
    left.productBootstrap.restoreMode === right.productBootstrap.restoreMode &&
    left.facet.processId === right.facet.processId &&
    left.facet.codeId === right.facet.codeId &&
    left.facet.residentBytes === right.facet.residentBytes &&
    left.facet.mainModule === right.facet.mainModule &&
    left.facet.entrypoint === right.facet.entrypoint &&
    sameHarnessProcessModules(left.facet.modules, right.facet.modules)
  );
}
