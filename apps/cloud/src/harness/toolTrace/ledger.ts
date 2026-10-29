import type {
  HarnessExpectedToolCall,
  HarnessToolHookReceipt,
  HarnessToolHookEvent,
  HarnessChildProcessObservation,
  HarnessChildProcessSpawnRecord,
  HarnessToolTraceOptions,
  MutableChildProcess,
  HarnessProcessCaptureReceipt,
} from "./types.ts";
import { readField } from "./matching.ts";
import { finalizeHarnessToolTrace } from "./finalize.ts";

/** Records only observable SDK hook and child-process facts; associations are computed at finalize. */
export function createHarnessToolTraceLedger(options: HarnessToolTraceOptions = {}) {
  let sequence = 0;
  const hooks: HarnessToolHookReceipt[] = [];
  const processCaptures: HarnessProcessCaptureReceipt[] = [];
  const children = new Map<string, MutableChildProcess>();
  const spawnObservations = new Map<string, HarnessChildProcessSpawnRecord[]>();
  const unattachedReceipts: {
    readonly childId: string;
    readonly kind: "close" | "trace";
    readonly sequence: number;
    readonly raw: unknown;
  }[] = [];

  const nextSequence = () => ++sequence;

  function observeProcessCapture(
    processKey: string,
    phase: "attached" | "drained",
    complete: boolean,
    raw: unknown,
  ) {
    processCaptures.push({ processKey, phase, complete, raw, sequence: nextSequence() });
  }

  function observeHook(
    processKey: string,
    event: HarnessToolHookEvent,
    raw: unknown,
    callbackToolUseId: string | undefined,
  ) {
    hooks.push({
      processKey,
      event,
      sequence: nextSequence(),
      callbackToolUseId,
      raw,
      fields: {
        hook_event_name: readField(raw, "hook_event_name"),
        session_id: readField(raw, "session_id"),
        tool_use_id: readField(raw, "tool_use_id"),
        tool_name: readField(raw, "tool_name"),
        tool_input: readField(raw, "tool_input"),
        cwd: readField(raw, "cwd"),
      },
    });
  }

  function observeChildSpawn(input: HarnessChildProcessObservation) {
    const spawnRecord = { ...input, argv: [...input.argv], sequence: nextSequence() };
    const observations = spawnObservations.get(input.childId) ?? [];
    observations.push(spawnRecord);
    spawnObservations.set(input.childId, observations);
    if (children.has(input.childId)) {
      return;
    }
    children.set(input.childId, {
      ...spawnRecord,
      closeReceipts: [],
      traceReceipts: [],
    });
  }

  function observeChildClose(childId: string, raw: unknown) {
    observeChildReceipt(childId, "close", raw);
  }

  function observeChildTraceReceipt(childId: string, raw: unknown) {
    observeChildReceipt(childId, "trace", raw);
  }

  function observeChildReceipt(childId: string, kind: "close" | "trace", raw: unknown) {
    const child = children.get(childId);
    if (child === undefined) {
      unattachedReceipts.push({ childId, kind, sequence: nextSequence(), raw });
      return;
    }
    const receipt = { sequence: nextSequence(), raw };
    if (kind === "close") child.closeReceipts.push(receipt);
    else child.traceReceipts.push(receipt);
  }

  const finalize = (expectedCalls: readonly HarnessExpectedToolCall[]) =>
    finalizeHarnessToolTrace(
      {
        hooks,
        processCaptures,
        children,
        spawnObservations,
        unattachedReceipts,
        ...(options.pathMapping === undefined ? {} : { pathMapping: options.pathMapping }),
      },
      expectedCalls,
    );

  return {
    observeProcessCapture,
    observeHook,
    observeChildSpawn,
    observeChildClose,
    observeChildTraceReceipt,
    finalize,
  };
}
