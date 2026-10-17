import type { RunnerRuntimeResponse } from "@signalbox/runner-protocol/RunnerProtocol";
import {
  NodeId,
  type OrchestrationV2RuntimeRequest,
  ProviderSessionId,
  ProviderTurnId,
  RuntimeRequestId,
  RunId,
} from "@t3tools/contracts";
import { ProviderAdapterRuntimeRequestResponseError } from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderDriverKind } from "@t3tools/contracts";
import type { ProviderAdapterV2RuntimeRequestResponseInput } from "@t3tools/provider-core/server/ProviderAdapter";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { makeRunnerRuntimeRequests } from "./RunnerRuntimeRequests.ts";

const providerSessionId = ProviderSessionId.make("session-1");
const providerTurnId = ProviderTurnId.make("turn-1");
const request: OrchestrationV2RuntimeRequest = {
  id: RuntimeRequestId.make("request-1"),
  nodeId: NodeId.make("node-1"),
  providerTurnId,
  nativeRequestRef: null,
  kind: "user_input",
  status: "pending",
  responseCapability: { type: "live", providerSessionId },
  createdAt: DateTime.makeUnsafe(0),
  resolvedAt: null,
};
const response: RunnerRuntimeResponse = {
  runId: RunId.make("run-1"),
  requestId: request.id,
  providerSessionId,
  providerTurnId,
  answers: { destination: "Zurich" },
};
const sessionFor = (calls: Array<ProviderAdapterV2RuntimeRequestResponseInput>) => ({
  providerSessionId,
  respondToRuntimeRequest: (input: ProviderAdapterV2RuntimeRequestResponseInput) =>
    Effect.sync(() => void calls.push(input)),
});

describe("RunnerRuntimeRequests", () => {
  it.effect("answers the original callback once when the cloud replays after reconnect", () =>
    Effect.gen(function* () {
      const requests = makeRunnerRuntimeRequests();
      const calls: Array<ProviderAdapterV2RuntimeRequestResponseInput> = [];
      const session = sessionFor(calls);
      requests.observe(session, request);
      expect(yield* requests.respond(session, response)).toBe(true);
      expect(yield* requests.respond(session, response)).toBe(true);
      expect(calls).toEqual([{ requestId: request.id, answers: response.answers }]);
    }),
  );

  it.effect("answers approval callbacks with the committed decision", () =>
    Effect.gen(function* () {
      const requests = makeRunnerRuntimeRequests();
      const calls: Array<ProviderAdapterV2RuntimeRequestResponseInput> = [];
      const session = sessionFor(calls);
      requests.observe(session, { ...request, kind: "command" });
      const { answers: _answers, ...approval } = response;
      expect(yield* requests.respond(session, { ...approval, decision: "accept" })).toBe(true);
      expect(calls).toEqual([{ requestId: request.id, decision: "accept" }]);
    }),
  );

  it.effect("rejects unknown, expired, stopped and replaced-session callbacks", () =>
    Effect.gen(function* () {
      const requests = makeRunnerRuntimeRequests();
      const calls: Array<ProviderAdapterV2RuntimeRequestResponseInput> = [];
      const session = sessionFor(calls);
      expect(yield* requests.respond(session, response)).toBe(false);
      requests.observe(session, { ...request, status: "expired" });
      expect(yield* requests.respond(session, response)).toBe(false);
      requests.observe(session, request);
      expect(
        yield* requests.respond(session, {
          ...response,
          providerTurnId: ProviderTurnId.make("old"),
        }),
      ).toBe(false);
      expect(
        yield* requests.respond(session, {
          ...response,
          providerSessionId: ProviderSessionId.make("old"),
        }),
      ).toBe(false);
      expect(yield* requests.respond(sessionFor(calls), response)).toBe(false);
      requests.expire(session, providerTurnId);
      expect(yield* requests.respond(session, response)).toBe(false);
      requests.observe(session, request);
      requests.close(session);
      expect(yield* requests.respond(session, response)).toBe(false);
      expect(calls).toEqual([]);
    }),
  );

  it.effect("allows a reconnect retry after a failed callback without exposing its error", () =>
    Effect.gen(function* () {
      const requests = makeRunnerRuntimeRequests();
      const calls: Array<ProviderAdapterV2RuntimeRequestResponseInput> = [];
      let attempts = 0;
      const session = {
        providerSessionId,
        respondToRuntimeRequest: (input: ProviderAdapterV2RuntimeRequestResponseInput) =>
          Effect.suspend(() =>
            ++attempts === 1
              ? Effect.fail(
                  new ProviderAdapterRuntimeRequestResponseError({
                    driver: ProviderDriverKind.make("codex"),
                    requestId: request.id,
                    cause: new Error("private answer must not escape"),
                  }),
                )
              : Effect.sync(() => void calls.push(input)),
          ),
      };
      requests.observe(session, request);
      expect(yield* requests.respond(session, response)).toBe(false);
      expect(yield* requests.respond(session, response)).toBe(true);
      expect(calls).toEqual([{ requestId: request.id, answers: response.answers }]);
    }),
  );
});
