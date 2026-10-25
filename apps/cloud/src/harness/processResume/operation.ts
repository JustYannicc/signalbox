import type {
  HarnessProcessResumeFacetCode,
  HarnessProcessResumeOperationInput,
} from "./contracts.ts";
import { snapshotHarnessProcessResumeRunStoreBinding } from "./runStoreBinding.ts";
import { samePreparedRelease, snapshotInput } from "./identity.ts";

const text = (value: unknown, maximum = 256): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;

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

    const modules: Record<string, string | { readonly js: string }> = {};
    for (const [name, supplied] of Object.entries(facet.modules)) {
      if (!text(name)) return undefined;
      if (typeof supplied === "string") {
        modules[name] = supplied;
        continue;
      }
      if (
        typeof supplied !== "object" ||
        supplied === null ||
        Array.isArray(supplied) ||
        Object.keys(supplied).length !== 1 ||
        typeof (supplied as { readonly js?: unknown }).js !== "string"
      )
        return undefined;
      modules[name] = Object.freeze({ js: (supplied as { readonly js: string }).js });
    }
    if (!Object.hasOwn(modules, facet.mainModule)) return undefined;
    return Object.freeze({
      processId: facet.processId,
      codeId: facet.codeId,
      residentBytes: facet.residentBytes as number,
      mainModule: facet.mainModule,
      modules: Object.freeze(modules),
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
      Object.keys(supplied).some(
        (key) =>
          key !== "runId" &&
          key !== "previousProcessId" &&
          key !== "previousOperationId" &&
          key !== "previousStepId" &&
          key !== "runStore" &&
          key !== "transition" &&
          key !== "facet",
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
  const sameModuleRecords = (
    a: HarnessProcessResumeFacetCode["modules"],
    b: HarnessProcessResumeFacetCode["modules"],
  ) => {
    const names = Object.keys(a);
    return (
      names.length === Object.keys(b).length &&
      names.every((name) => {
        if (!Object.hasOwn(b, name)) return false;
        const leftModule = a[name];
        const rightModule = b[name];
        if (leftModule === undefined || rightModule === undefined) return false;
        if (typeof leftModule === "string" || typeof rightModule === "string")
          return leftModule === rightModule;
        return leftModule.js === rightModule.js;
      })
    );
  };
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
    left.facet.processId === right.facet.processId &&
    left.facet.codeId === right.facet.codeId &&
    left.facet.residentBytes === right.facet.residentBytes &&
    left.facet.mainModule === right.facet.mainModule &&
    left.facet.entrypoint === right.facet.entrypoint &&
    sameModuleRecords(left.facet.modules, right.facet.modules)
  );
}
