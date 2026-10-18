import {
  SECRET_REQUEST_PATH,
  secretRequestJson,
} from "@signalbox/runner-protocol/SecretRequestProtocol";
import * as Effect from "effect/Effect";

import { ThreadSecretRequests } from "./ThreadSecretRequests.ts";

/** Called only after the session API verifies its bearer token and machine generation. */
export const serveSecretRequest = (generation: number, body: string) =>
  Effect.gen(function* () {
    const request = yield* Effect.try({
      try: () => secretRequestJson.request.decode(body),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null));
    if (request === null) return { status: 400, body: "Unreadable request.", json: false };
    const service = yield* ThreadSecretRequests;
    return yield* service.request(generation, request).pipe(
      Effect.map((result) => ({
        status: 200,
        body: secretRequestJson.result.encode(result),
        json: true,
      })),
      Effect.catchTags({
        SecretRequestError: (error) =>
          Effect.succeed({
            status: error.reason === "agent_stopped" ? 403 : 409,
            body: error.message,
            json: false,
          }),
      }),
    );
  });

export const isSecretRequestPath = (path: string) => path === SECRET_REQUEST_PATH;
