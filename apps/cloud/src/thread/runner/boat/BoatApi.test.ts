import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";

import { makeBoatApi } from "./BoatApi.ts";

const apiWith = (reply: unknown) =>
  makeBoatApi(
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(reply))),
    ),
    { baseUrl: "https://boat.test/api/v1", apiKey: Redacted.make("key") },
  );

describe("Boat setup commands", () => {
  it.effect("accepts only a completed successful command", () =>
    apiWith({ success: true, exitCode: 0, timedOut: false }).execute("bx_1", "true"),
  );

  it.effect("does not accept a failed, timed out, or incomplete setup as installed", () =>
    Effect.gen(function* () {
      for (const reply of [
        { success: false, exitCode: 1, timedOut: false },
        { success: false, exitCode: null, timedOut: true },
        { success: true, processId: 10 },
      ]) {
        const error = yield* Effect.flip(apiWith(reply).execute("bx_1", "true"));
        expect(error.operation).toBe("execute");
      }
    }),
  );
});
