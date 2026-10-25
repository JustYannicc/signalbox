import * as Schema from "effect/Schema";
import {
  HarnessProcessResumeRunStoreBindingSchema,
  type HarnessProcessResumeRunStoreBinding,
} from "./contracts.ts";

const decodeBinding = Schema.decodeUnknownSync(HarnessProcessResumeRunStoreBindingSchema, {
  onExcessProperty: "error",
});

/** Copies only the accepted serializable fields; never expose parser details containing capabilities. */
export function snapshotHarnessProcessResumeRunStoreBinding(
  value: unknown,
): HarnessProcessResumeRunStoreBinding | undefined {
  try {
    const decoded = decodeBinding(value);
    const keys = [
      decoded.controlKey,
      decoded.supervisor.supervisorKey,
      decoded.currentPublisher.publisherKey,
      decoded.nextPublisherKey,
    ];
    if (new Set(keys).size !== keys.length) return undefined;
    return Object.freeze({
      runId: decoded.runId,
      processId: decoded.processId,
      processOperationId: decoded.processOperationId,
      transitionOperationId: decoded.transitionOperationId,
      controlKey: decoded.controlKey,
      supervisor: Object.freeze({ ...decoded.supervisor }),
      currentPublisher: Object.freeze({ ...decoded.currentPublisher }),
      nextPublisherKey: decoded.nextPublisherKey,
      request: Object.freeze({
        requestId: decoded.request.requestId,
        input: Object.freeze({ ...decoded.request.input }),
      }),
      checkpoint: Object.freeze({
        native: Object.freeze({ ...decoded.checkpoint.native }),
        filesystem: Object.freeze({ ...decoded.checkpoint.filesystem }),
      }),
    });
  } catch {
    return undefined;
  }
}
