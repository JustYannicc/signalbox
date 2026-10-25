import type { KnownTerminalSession } from "@t3tools/client-runtime/state/terminal";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useRef } from "react";

export type OpenedTerminalGenerations = Map<
  ScopedThreadRef["environmentId"],
  Map<ScopedThreadRef["threadId"], Map<string, number | undefined>>
>;
type TerminalGenerationSession = {
  readonly target: Pick<KnownTerminalSession["target"], "terminalId">;
  readonly state: Pick<KnownTerminalSession["state"], "generation">;
};
type TerminalCloseResultTag = "Failure" | "Success";

export interface TerminalGenerationSelection {
  readonly threadRef: ScopedThreadRef;
  readonly terminalId: string;
  readonly sessions: ReadonlyArray<TerminalGenerationSession> | null;
  readonly preferOpenedSnapshot?: boolean;
}

export function createOpenedTerminalGenerations(): OpenedTerminalGenerations {
  return new Map();
}

function generationsForThread(
  generations: OpenedTerminalGenerations,
  threadRef: ScopedThreadRef,
  create: boolean,
): Map<string, number | undefined> | null {
  let byThread = generations.get(threadRef.environmentId);
  if (!byThread) {
    if (!create) return null;
    byThread = new Map();
    generations.set(threadRef.environmentId, byThread);
  }

  let byTerminal = byThread.get(threadRef.threadId);
  if (!byTerminal && create) {
    byTerminal = new Map();
    byThread.set(threadRef.threadId, byTerminal);
  }
  return byTerminal ?? null;
}

export function rememberOpenedTerminalGeneration(
  generations: OpenedTerminalGenerations,
  threadRef: ScopedThreadRef,
  terminalId: string,
  generation: number | undefined,
): void {
  const threadGenerations = generationsForThread(generations, threadRef, true)!;

  const hasPrevious = threadGenerations.has(terminalId);
  const previous = threadGenerations.get(terminalId);
  // Open responses can arrive out of order; generations only increase on restart.
  if (
    hasPrevious &&
    previous !== undefined &&
    (generation === undefined || generation < previous)
  ) {
    return;
  }
  threadGenerations.set(terminalId, generation);
}

function forgetOpenedTerminalGeneration(
  generations: OpenedTerminalGenerations,
  threadRef: ScopedThreadRef,
  terminalId: string,
): void {
  const threadGenerations = generationsForThread(generations, threadRef, false);
  if (!threadGenerations) return;
  threadGenerations.delete(terminalId);
  if (threadGenerations.size === 0) {
    const byThread = generations.get(threadRef.environmentId)!;
    byThread.delete(threadRef.threadId);
    if (byThread.size === 0) generations.delete(threadRef.environmentId);
  }
}

export function selectTerminalGeneration(
  generations: OpenedTerminalGenerations,
  options: TerminalGenerationSelection,
): number | undefined {
  const threadGenerations = generationsForThread(generations, options.threadRef, false);
  const hasOpenedSnapshot = threadGenerations?.has(options.terminalId) ?? false;
  const openedSnapshot = threadGenerations?.get(options.terminalId);
  const knownSession =
    options.sessions?.find((session) => session.target.terminalId === options.terminalId) ?? null;
  const knownGeneration = knownSession?.state.generation;

  // Keep a fresh open ahead of lagging metadata, but accept metadata that proves a restart.
  if (options.preferOpenedSnapshot && hasOpenedSnapshot) {
    if (
      openedSnapshot !== undefined &&
      knownGeneration !== undefined &&
      knownGeneration > openedSnapshot
    ) {
      return knownGeneration;
    }
    return openedSnapshot;
  }
  if (knownSession !== null) return knownGeneration;
  return openedSnapshot;
}

export function forgetTerminalGenerationAfterClose(
  generations: OpenedTerminalGenerations,
  threadRef: ScopedThreadRef | null,
  terminalId: string,
  closeResultTag: TerminalCloseResultTag,
): void {
  if (closeResultTag === "Success" && threadRef !== null) {
    forgetOpenedTerminalGeneration(generations, threadRef, terminalId);
  }
}

export function useSignalboxTerminalGenerations(threadRef: ScopedThreadRef | null): {
  readonly rememberOpened: (terminalId: string, generation: number | undefined) => void;
  readonly forgetAfterClose: (terminalId: string, closeResultTag: TerminalCloseResultTag) => void;
  readonly generationFor: (
    terminalId: string,
    sessions: ReadonlyArray<TerminalGenerationSession> | null,
    preferOpenedSnapshot?: boolean,
  ) => number | undefined;
} {
  const generationsRef = useRef(createOpenedTerminalGenerations());
  return {
    rememberOpened: (terminalId, generation) => {
      if (threadRef !== null) {
        rememberOpenedTerminalGeneration(generationsRef.current, threadRef, terminalId, generation);
      }
    },
    forgetAfterClose: (terminalId, closeResultTag) =>
      forgetTerminalGenerationAfterClose(
        generationsRef.current,
        threadRef,
        terminalId,
        closeResultTag,
      ),
    generationFor: (terminalId, sessions, preferOpenedSnapshot = false) =>
      threadRef === null
        ? undefined
        : selectTerminalGeneration(generationsRef.current, {
            threadRef,
            terminalId,
            sessions,
            preferOpenedSnapshot,
          }),
  };
}
