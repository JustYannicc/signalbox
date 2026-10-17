import type { RunnerRuntimeResponse } from "@signalbox/runner-protocol/RunnerProtocol";
import type { OrchestrationV2RuntimeRequest, ProviderTurnId } from "@t3tools/contracts";
import type { ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";

type Session = Pick<
  ProviderAdapterV2SessionRuntime,
  "providerSessionId" | "respondToRuntimeRequest"
>;

/** Callback identity belongs to the open session, even when native ids are reused after restart. */
export const makeRunnerRuntimeRequests = () => {
  const pending = new Map<Session, Map<string, OrchestrationV2RuntimeRequest>>();
  const answered = new Map<Session, Set<string>>();

  const observe = (session: Session, request: OrchestrationV2RuntimeRequest) => {
    let requests = pending.get(session);
    if (requests === undefined) {
      requests = new Map();
      pending.set(session, requests);
    }
    if (request.status === "pending") requests.set(request.id, request);
    else requests.delete(request.id);
  };

  const expire = (session: Session, providerTurnId: ProviderTurnId) => {
    for (const [id, request] of pending.get(session) ?? []) {
      if (request.providerTurnId === providerTurnId) pending.get(session)?.delete(id);
    }
  };

  const close = (session: Session) => {
    pending.delete(session);
    answered.delete(session);
  };

  const respond = (session: Session, response: RunnerRuntimeResponse) =>
    Effect.gen(function* () {
      if (session.providerSessionId !== response.providerSessionId) return false;
      // Mark before yielding: a replay cannot race the same live callback.
      if (answered.get(session)?.has(response.requestId)) return true;
      const request = pending.get(session)?.get(response.requestId);
      if (
        request === undefined ||
        request.status !== "pending" ||
        request.providerTurnId !== response.providerTurnId ||
        request.responseCapability.type !== "live" ||
        request.responseCapability.providerSessionId !== session.providerSessionId ||
        (request.kind === "user_input"
          ? response.answers === undefined || response.decision !== undefined
          : response.decision === undefined || response.answers !== undefined)
      ) {
        return false;
      }
      let done = answered.get(session);
      if (done === undefined) {
        done = new Set();
        answered.set(session, done);
      }
      done.add(response.requestId);
      const result = yield* Effect.exit(
        session.respondToRuntimeRequest({
          requestId: response.requestId,
          ...(response.answers === undefined ? {} : { answers: response.answers }),
          ...(response.decision === undefined ? {} : { decision: response.decision }),
        }),
      );
      if (result._tag === "Failure") {
        done.delete(response.requestId);
        // Adapter errors can contain answers; never persist them as diagnostic text.
        return false;
      }
      pending.get(session)?.delete(response.requestId);
      return true;
    });

  return { observe, expire, close, respond };
};
