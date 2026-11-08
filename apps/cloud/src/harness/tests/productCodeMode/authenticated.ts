import { RunId } from "@t3tools/contracts";
import { secretPlaceholder } from "@signalbox/runner-protocol/SecretScrubber";
import * as Effect from "effect/Effect";
import { makeModelAccess } from "../../../models/testing.ts";
import { handleModelRequest } from "../../../models/ModelGateway.ts";

export async function authenticatedGateway() {
  const token = `sbm1.${btoa("product-code-mode").replace(/=+$/, "")}.fixture`;
  const secret = "native-test-only-secret-value";
  const requests: { body: string; authorization: string | null }[] = [];
  const arrivals: { authenticated: boolean; status: number }[] = [];
  const access = await Effect.runPromise(
    makeModelAccess({
      authorizeThread: async (thread, value) =>
        value === token && thread === "product-code-mode"
          ? {
              _tag: "granted",
              runId: RunId.make("native-auth"),
              traceId: "0".repeat(32),
              pool: { objectName: "native-auth", userId: "fixture" },
              secrets: [{ name: "FIXTURE_SECRET", value: secret }],
            }
          : { _tag: "denied", reason: "Wrong model token" },
      authorizeLocal: async () => ({ _tag: "denied", reason: "Not a local key" }),
      forward: async (_pool, _path, request) => {
        requests.push({
          body: await request.text(),
          authorization: request.headers.get("authorization"),
        });
        const id = `authenticated-${requests.length}`;
        const events = [
          { type: "response.created", response: { id } },
          {
            type: "response.output_item.done",
            item: {
              type: "message",
              id: `message-${id}`,
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "Authenticated." }],
            },
          },
          {
            type: "response.completed",
            response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
          },
        ];
        return {
          _tag: "forwarded",
          upstreamMs: 0,
          response: new Response(
            events
              .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          ),
        };
      },
      recordThread: async () => undefined,
      recordLocal: async () => undefined,
    }),
  );
  return {
    token,
    secret,
    requests,
    arrivals,
    placeholder: secretPlaceholder("FIXTURE_SECRET"),
    async fetch(request: Request) {
      const authenticated = request.headers.get("authorization") === `Bearer ${token}`;
      const url = new URL(request.url);
      const response = await handleModelRequest(
        new Request(`http://gateway.test/openai${url.pathname}`, request),
        {
          serve: (token, provider, path, request) =>
            access.serve({ token, provider, path, request }),
          now: () => 0,
          log: () => undefined,
        },
      );
      arrivals.push({ authenticated, status: response.status });
      return response;
    },
  };
}
