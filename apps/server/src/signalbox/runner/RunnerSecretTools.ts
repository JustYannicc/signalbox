import {
  SECRET_REQUEST_PATH,
  secretRequestJson,
} from "@signalbox/runner-protocol/SecretRequestProtocol";
import type { SessionAccess } from "@signalbox/runner-protocol/SessionProtocol";
import {
  OrchestratorMcpRequestSecretInput,
  RunAttemptId,
  RunId,
  type OrchestratorMcpRequestSecretResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { fail, json, register, ToolError } from "./RunnerContextTools.ts";

type Identity = { readonly runId: string; readonly attemptId: string };
type Binding = Identity & { readonly sessions: SessionAccess };

export interface RunnerSecretRequests {
  readonly pin: (binding: Binding) => void;
  readonly clear: (identity: Identity) => void;
  readonly request: (
    input: typeof OrchestratorMcpRequestSecretInput.Type,
  ) => Effect.Effect<OrchestratorMcpRequestSecretResult, ToolError>;
}

/** The active turn's session token stays in the Runner, outside the MCP arguments and result. */
export const makeRunnerSecretRequests = Effect.fn("makeRunnerSecretRequests")(function* (
  cloudUrl: string,
) {
  const http = yield* HttpClient.HttpClient;
  let current: Binding | null = null;
  return {
    pin: (binding) => {
      current = binding;
    },
    clear: (identity) => {
      if (current?.runId === identity.runId && current.attemptId === identity.attemptId)
        current = null;
    },
    request: (input) =>
      Effect.gen(function* () {
        const binding = current;
        if (binding === null) return yield* fail("Only the active turn can request a secret.");
        const response = yield* http
          .execute(
            HttpClientRequest.post(`${cloudUrl.replace(/\/+$/, "")}${SECRET_REQUEST_PATH}`).pipe(
              HttpClientRequest.bearerToken(binding.sessions.token),
              HttpClientRequest.bodyText(
                secretRequestJson.request.encode({
                  runId: RunId.make(binding.runId),
                  attemptId: RunAttemptId.make(binding.attemptId),
                  input,
                }),
                "application/json",
              ),
            ),
          )
          .pipe(
            Effect.mapError(
              () =>
                new ToolError({
                  message:
                    "The cloud did not answer the secret request. Retry with the same clientRequestId.",
                }),
            ),
          );
        if (response.status !== 200)
          return yield* fail("The secret request was refused or its turn stopped.");
        const body = yield* response.text.pipe(
          Effect.mapError(
            () => new ToolError({ message: "The cloud's secret request answer was interrupted." }),
          ),
        );
        return yield* Effect.try({
          try: () => secretRequestJson.result.decode(body),
          catch: () =>
            new ToolError({ message: "The cloud's secret request answer was unreadable." }),
        });
      }).pipe(
        Effect.timeoutOrElse({
          duration: (input.timeoutMs ?? 600_000) + 5000,
          orElse: () =>
            fail(
              "The cloud did not answer the secret request. Retry with the same clientRequestId.",
            ),
        }),
      ),
  } satisfies RunnerSecretRequests;
});

export const layerSecretTools = (requests: RunnerSecretRequests) =>
  Layer.effectDiscard(
    register({
      name: "request_secret",
      description:
        "Ask the user for a secret through a private card and wait for their answer. The app keeps the value and never returns it to you or writes it in the transcript. A saved answer contains an opaque, one-use secretRef for an approved tool that accepts it. Never ask for secrets in chat or invent one. Reuse clientRequestId when retrying an interrupted call.",
      parameters: OrchestratorMcpRequestSecretInput,
      writes: { destructive: false, openWorld: false },
      handle: (input) => requests.request(input).pipe(Effect.map(json)),
    }),
  );
