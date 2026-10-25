import { inspectCodexNativeRecovery } from "@signalbox/provider-codex/runtime";
import type {
  CodexNativeAdmission,
  CodexNativePendingAction,
  CodexNativeReference,
} from "@signalbox/provider-codex/runtime";

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface StartedCodexThread {
  readonly nativeSessionId: string;
  readonly path: string;
}

/** Use the identity Codex returned instead of discovering it by scanning HOME. */
export function requireStartedCodexThread(frames: ReadonlyArray<unknown>): StartedCodexThread {
  const matches = frames.filter(
    (frame): frame is RecordValue => isRecord(frame) && frame.method === "thread/started",
  );
  if (matches.length !== 1) {
    throw new Error(`Expected one Codex thread/started frame, found ${matches.length}`);
  }
  const params = matches[0]!.params;
  const thread = isRecord(params) ? params.thread : undefined;
  const nativeSessionId = isRecord(thread) ? thread.id : undefined;
  const path = isRecord(thread) ? thread.path : undefined;
  if (
    typeof nativeSessionId !== "string" ||
    nativeSessionId.length === 0 ||
    typeof path !== "string" ||
    !path.startsWith("/home/codex/sessions/") ||
    !path.endsWith(`-${nativeSessionId}.jsonl`)
  ) {
    throw new Error("Codex thread/started did not identify its canonical session rollout");
  }
  return { nativeSessionId, path };
}

/** Inspect the exact rollout named by Codex after stop, through the production recovery parser. */
export function inspectStoppedCodexRecovery(input: {
  readonly frames: ReadonlyArray<unknown>;
  readonly admission: CodexNativeAdmission;
  readonly nextNativeIncarnationId: string;
  readonly stopped: {
    readonly nativeIncarnationId: string;
    readonly reference: CodexNativeReference;
  };
  readonly file: { readonly reference: CodexNativeReference; readonly contents: string };
  readonly pendingActions: ReadonlyArray<CodexNativePendingAction>;
}) {
  const started = requireStartedCodexThread(input.frames);
  if (started.nativeSessionId !== input.admission.nativeSessionId) {
    throw new Error("Codex thread/started identity differs from the admitted native session");
  }
  return inspectCodexNativeRecovery({
    admission: input.admission,
    nextNativeIncarnationId: input.nextNativeIncarnationId,
    stopped: input.stopped,
    file: { path: started.path, ...input.file },
    pendingActions: input.pendingActions,
  });
}
