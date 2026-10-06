import { describe, expect, it } from "@effect/vitest";
import * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";

import { listCredentials } from "./accountHubManagement.ts";

const answering = (response: () => Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => HttpClientResponse.fromWeb(request, response())),
    ),
  );

// A port that was just free and is now closed, so connecting is refused.
const closedPort = Effect.promise(
  () =>
    new Promise<number>((resolve) => {
      const server = NodeNet.createServer().listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        server.close(() => resolve(port));
      });
    }),
);

const failureDetail = (baseUrl: string) =>
  listCredentials({ baseUrl, managementKey: "key" }).pipe(
    Effect.flip,
    Effect.map((error) => error.detail),
  );

describe("management errors name the real problem", () => {
  it.effect("a rejected key says so", () =>
    failureDetail("https://hub.example.com").pipe(
      Effect.provide(answering(() => new Response("unauthorized", { status: 401 }))),
      Effect.map((detail) => expect(detail).toBe("hub.example.com rejected the management key.")),
    ),
  );

  it.effect("a host that is not a CLIProxyAPI is not called unreachable", () =>
    failureDetail("https://hub.example.com").pipe(
      Effect.provide(answering(() => new Response("<html></html>", { status: 404 }))),
      Effect.map((detail) =>
        expect(detail).toBe("hub.example.com did not answer like a CLIProxyAPI (HTTP 404)."),
      ),
    ),
  );

  it.live("a refused connection names the host and the code", () =>
    Effect.gen(function* () {
      const port = yield* closedPort;
      const detail = yield* failureDetail(`http://127.0.0.1:${port}`);
      expect(detail).toBe(`Could not reach 127.0.0.1:${port} (ECONNREFUSED).`);
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
});
