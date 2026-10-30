import { NATIVE_SESSION_UUID } from "../processCreation/identity.ts";
import type { ThreadId } from "@t3tools/contracts";
import type { HarnessCheckpoint } from "../Harness.ts";
import type { HarnessHostSession } from "../HarnessSessionHost.ts";

export function validateInitialCheckpoint<G>(input: {
  readonly checkpoint: HarnessCheckpoint;
  readonly session: HarnessHostSession<G>;
  readonly provider: string;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: string;
  readonly creationThread: HarnessCheckpoint["snapshot"]["providerThread"];
}): string {
  const { checkpoint, session, provider, threadId, providerSessionId, providerInstanceId } = input;
  const thread = checkpoint.snapshot.providerThread;
  const nativeThreadRef = thread.nativeThreadRef;
  if (
    checkpoint.release.harness !== provider ||
    checkpoint.providerSession.id !== providerSessionId ||
    checkpoint.providerSession.id !== session.providerSession.id ||
    checkpoint.providerSession.driver !== (provider === "claude-code" ? "claudeAgent" : "codex") ||
    checkpoint.providerSession.providerInstanceId !== providerInstanceId ||
    thread.appThreadId !== threadId ||
    thread.providerSessionId !== checkpoint.providerSession.id ||
    thread.providerInstanceId !== providerInstanceId ||
    thread.driver !== checkpoint.providerSession.driver ||
    thread.id !== input.creationThread.id ||
    thread.appThreadId !== input.creationThread.appThreadId ||
    thread.providerSessionId !== input.creationThread.providerSessionId ||
    thread.providerInstanceId !== input.creationThread.providerInstanceId ||
    thread.driver !== input.creationThread.driver ||
    thread.nativeThreadRef?.driver !== thread.driver ||
    nativeThreadRef === null ||
    nativeThreadRef.nativeId === null ||
    !NATIVE_SESSION_UUID.test(nativeThreadRef.nativeId) ||
    checkpoint.snapshot.providerTurns.length !== 0 ||
    checkpoint.snapshot.messages.length !== 0 ||
    checkpoint.snapshot.runtimeRequests.length !== 0
  )
    throw new Error(
      "The exported checkpoint does not contain this fresh provider session and thread.",
    );
  return nativeThreadRef.nativeId;
}
