import { secretRequestJson } from "@signalbox/runner-protocol/SecretRequestProtocol";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { makeRunnerSecretRequests } from "./RunnerSecretTools.ts";

const input = {
  label: "Webhook secret",
  reason: "Verifies requests.",
  clientRequestId: "same-request",
};

describe("Runner secret request tools", () => {
  it.effect("pins the live identity and does not let an old turn clear a newer one", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly body: string; readonly token: string }> = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          if (request.body._tag !== "Uint8Array") throw new Error("Expected request body");
          calls.push({
            body: new TextDecoder().decode(request.body.body),
            token: request.headers.authorization ?? "",
          });
          return HttpClientResponse.fromWeb(
            request,
            new Response(secretRequestJson.result.encode({ status: "declined" }), { status: 200 }),
          );
        }),
      );
      const requests = yield* makeRunnerSecretRequests("https://cloud.test/").pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      expect(yield* requests.request(input).pipe(Effect.result)).toMatchObject({ _tag: "Failure" });
      requests.pin({ runId: "run-1", attemptId: "attempt-1", sessions: { token: "old-token" } });
      requests.pin({ runId: "run-2", attemptId: "attempt-2", sessions: { token: "new-token" } });
      requests.clear({ runId: "run-1", attemptId: "attempt-1" });
      expect(yield* requests.request(input)).toEqual({ status: "declined" });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.token).toBe("Bearer new-token");
      expect(secretRequestJson.request.decode(calls[0]!.body)).toEqual({
        runId: "run-2",
        attemptId: "attempt-2",
        input,
      });
      requests.clear({ runId: "run-2", attemptId: "attempt-2" });
      expect(yield* requests.request(input).pipe(Effect.result)).toMatchObject({ _tag: "Failure" });
      expect(calls).toHaveLength(1);
    }),
  );

  it.effect("does not quote a rejected response or transport error", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response("private-response-detail", { status: 500 }),
          ),
        ),
      );
      const requests = yield* makeRunnerSecretRequests("https://cloud.test").pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      requests.pin({ runId: "run", attemptId: "attempt", sessions: { token: "session-token" } });
      const result = yield* requests.request(input).pipe(Effect.result);
      expect(result).toMatchObject({ _tag: "Failure" });
      expect(JSON.stringify(result)).not.toContain("private-response-detail");
    }),
  );
});
