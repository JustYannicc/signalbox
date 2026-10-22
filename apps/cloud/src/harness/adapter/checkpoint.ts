import {
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import type {
  ProviderAdapterV2SessionRuntime,
  ProviderAdapterV2ThreadSnapshot,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { HarnessError, type HarnessOpenInput } from "../Harness.ts";
import { mergeRequests, requestBelongsToSession, sameRequestIdentity } from "./requestState.ts";

const sameSession = Schema.toEquivalence(OrchestrationV2ProviderSession);
const sameRef = Schema.toEquivalence(Schema.NullOr(OrchestrationV2ProviderRef));
const sameRelease = (a: HarnessOpenInput["release"], b: HarnessOpenInput["release"]) =>
  a.harness === b.harness &&
  a.version === b.version &&
  a.manifestSha256 === b.manifestSha256 &&
  Object.keys(a.modules).length === Object.keys(b.modules).length &&
  Object.entries(a.modules).every(
    ([key, module]) =>
      module.bytes === b.modules[key]?.bytes && module.sha256 === b.modules[key]?.sha256,
  );

export const validateOpen = (input: HarnessOpenInput) =>
  Effect.gen(function* () {
    if (input.computer.threadId !== input.session.threadId) {
      return yield* Effect.fail(
        new HarnessError({
          operation: "open",
          message: "Computer belongs to another thread.",
        }),
      );
    }
    const checkpoint = input.checkpoint;
    if (checkpoint === undefined) return input;
    const { providerSession, snapshot } = checkpoint;
    if (
      !sameRelease(input.release, checkpoint.release) ||
      providerSession.id !== input.session.providerSessionId ||
      providerSession.providerInstanceId !== input.session.modelSelection.instanceId ||
      providerSession.driver !== snapshot.providerThread.driver ||
      !threadMatches(snapshot.providerThread, input) ||
      snapshot.providerThread.nativeThreadRef?.nativeId == null ||
      !stableSnapshot(snapshot) ||
      snapshot.runtimeRequests.some(
        (request) => !requestBelongsToSession(request, input, providerSession.driver),
      ) ||
      (input.session.initialNativeThreadId !== undefined &&
        input.session.initialNativeThreadId !== snapshot.providerThread.nativeThreadRef.nativeId) ||
      (input.session.resumeFromSession !== undefined &&
        !sameSession(input.session.resumeFromSession, providerSession))
    ) {
      return yield* Effect.fail(
        new HarnessError({
          operation: "open",
          message: "Checkpoint identity or state is invalid.",
        }),
      );
    }
    return {
      ...input,
      session: {
        ...input.session,
        resumeFromSession: providerSession,
        initialNativeThreadId: snapshot.providerThread.nativeThreadRef.nativeId,
        ...(snapshot.providerThread.nativeMetadata?.itemIdentityVersion === 2
          ? { initialProviderItemIdentityVersion: 2 as const }
          : {}),
      },
    };
  });

export const threadMatches = (thread: OrchestrationV2ProviderThread, input: HarnessOpenInput) =>
  thread.appThreadId === input.session.threadId &&
  thread.providerSessionId === input.session.providerSessionId &&
  thread.providerInstanceId === input.session.modelSelection.instanceId;

const stableSnapshot = (snapshot: ProviderAdapterV2ThreadSnapshot) =>
  (snapshot.providerThread.pendingBackgroundTasks?.length ?? 0) === 0 &&
  snapshot.providerThread.nativeThreadRef?.nativeId != null &&
  snapshot.providerThread.nativeThreadRef.driver === snapshot.providerThread.driver &&
  snapshot.providerTurns.every(
    (turn) =>
      turn.providerThreadId === snapshot.providerThread.id &&
      turn.status !== "pending" &&
      turn.status !== "running",
  ) &&
  snapshot.messages.every(
    (message) => message.threadId === snapshot.providerThread.appThreadId && !message.streaming,
  ) &&
  snapshot.runtimeRequests.every(
    (request) => request.status !== "pending" || request.responseCapability.type === "message",
  );

export const saveComputer = (
  input: HarnessOpenInput,
  operation: "events" | "export",
  failureSignal: AbortSignal,
) =>
  Effect.tryPromise({
    try: (signal) => {
      const saving = AbortSignal.any([signal, failureSignal]);
      saving.throwIfAborted();
      return input.computer.save(saving);
    },
    catch: (cause) =>
      new HarnessError({
        operation,
        message: "Computer state could not be saved.",
        cause,
      }),
  });

export const saveCheckpoint = (
  input: HarnessOpenInput,
  runtime: ProviderAdapterV2SessionRuntime,
  providerThread: OrchestrationV2ProviderThread,
  operation: "events" | "export",
  requests: ReadonlyMap<string, OrchestrationV2RuntimeRequest>,
  check: () => Effect.Effect<void, HarnessError>,
  failureSignal: AbortSignal,
) =>
  Effect.gen(function* () {
    if (
      yield* (
        runtime.hasPendingBackgroundWorkForThread?.(providerThread) ??
          runtime.hasPendingBackgroundWork ??
          Effect.succeed(false)
      )
    ) {
      return yield* Effect.fail(
        new HarnessError({
          operation,
          message: "Provider still has background work.",
        }),
      );
    }
    yield* check();
    const revision = yield* saveComputer(input, operation, failureSignal);
    yield* check();
    const nativeSnapshot = yield* runtime.readThreadSnapshot({ providerThread }).pipe(
      Effect.mapError(
        (cause) =>
          new HarnessError({
            operation,
            message: "Provider snapshot could not be read.",
            cause,
          }),
      ),
    );
    yield* check();
    for (const request of nativeSnapshot.runtimeRequests) {
      const prior = requests.get(request.id);
      if (
        !requestBelongsToSession(request, input, runtime.driver) ||
        (prior !== undefined && !sameRequestIdentity(prior, request))
      ) {
        return yield* Effect.fail(
          new HarnessError({ operation, message: "Provider request identity changed." }),
        );
      }
    }
    const snapshot = mergeRequests(nativeSnapshot, requests);
    if (
      !threadMatches(snapshot.providerThread, input) ||
      snapshot.providerThread.driver !== runtime.driver ||
      snapshot.providerThread.id !== providerThread.id ||
      !sameRef(snapshot.providerThread.nativeThreadRef, providerThread.nativeThreadRef) ||
      !stableSnapshot(snapshot) ||
      snapshot.runtimeRequests.some(
        (request) =>
          !requestBelongsToSession(request, input, runtime.driver) ||
          (!requests.has(request.id) &&
            !snapshot.providerTurns.some(
              (turn) =>
                turn.id === request.providerTurnId && turn.providerThreadId === providerThread.id,
            )),
      )
    ) {
      return yield* Effect.fail(
        new HarnessError({
          operation,
          message: "Provider snapshot is unstable or belongs to another thread.",
        }),
      );
    }
    return { release: input.release, providerSession: runtime.providerSession, snapshot, revision };
  });
