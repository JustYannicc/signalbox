import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";

import { makeGitHubApi } from "./GitHubApi.ts";

it.effect("keeps transport error text and request credentials out of logs", () => {
  const token = "github-transport-secret-canary";
  const detail = `A request carrying ${token} failed`;
  const lines: Array<string> = [];
  const client = HttpClient.make((request) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, cause: new Error(detail) }),
      }),
    ),
  );

  return Effect.gen(function* () {
    const error = yield* makeGitHubApi(client).viewer(token).pipe(Effect.flip);
    expect(error.message).toBe("GitHub did not answer.");
    const logs = lines.join("\n");
    expect(logs).toContain("GitHub request failed");
    expect(logs).toContain("viewer");
    expect(logs).toContain("TransportError");
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(detail);
  }).pipe(
    Effect.provide(Logger.layer([Logger.map(Logger.formatJson, (line) => void lines.push(line))])),
  );
});
