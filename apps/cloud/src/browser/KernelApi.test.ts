import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";

import { makeKernelApi } from "./KernelApi.ts";

/** Kernel answering each `METHOD path` from `answers`, recording what was asked. */
const fakeKernel = (
  answers: Record<string, { readonly status: number; readonly body?: unknown }>,
) => {
  const asked: Array<{ readonly route: string; readonly auth: string | undefined; body: unknown }> =
    [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const route = `${request.method} ${new URL(request.url).pathname}`;
      const bytes = request.body._tag === "Uint8Array" ? request.body.body : null;
      asked.push({
        route,
        auth: request.headers.authorization,
        body: bytes === null ? null : JSON.parse(new TextDecoder().decode(bytes)),
      });
      const answer = answers[route] ?? { status: 500 };
      return HttpClientResponse.fromWeb(
        request,
        new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
          status: answer.status,
        }),
      );
    }),
  );
  return { asked, api: makeKernelApi(client, { apiKey: Redacted.make("sk_test") }) };
};

describe("Kernel's API (#574)", () => {
  it.effect("takes an existing profile as created, with the key as bearer", () =>
    Effect.gen(function* () {
      const { asked, api } = fakeKernel({
        "POST /profiles": { status: 409, body: { code: "conflict", message: "exists" } },
      });
      yield* api.ensureProfile("sb-abc");
      expect(asked).toEqual([
        { route: "POST /profiles", auth: "Bearer sk_test", body: { name: "sb-abc" } },
      ]);
    }),
  );

  it.effect("reads a deleted or unknown browser as gone, and deleting a gone one as done", () =>
    Effect.gen(function* () {
      const { api } = fakeKernel({
        "GET /browsers/gone": { status: 404, body: { code: "not_found", message: "no" } },
        "GET /browsers/deleted": {
          status: 200,
          body: {
            session_id: "deleted",
            cdp_ws_url: "wss://x",
            deleted_at: "2026-10-16T00:00:00Z",
          },
        },
        "GET /browsers/live": { status: 200, body: { session_id: "live", cdp_ws_url: "wss://x" } },
        "DELETE /browsers/gone": { status: 404 },
      });
      expect(yield* api.getBrowser("gone")).toBeNull();
      expect(yield* api.getBrowser("deleted")).toBeNull();
      expect(yield* api.getBrowser("live")).toMatchObject({ session_id: "live" });
      yield* api.deleteBrowser("gone");
    }),
  );

  it.effect("fails with Kernel's code and message", () =>
    Effect.gen(function* () {
      const { api } = fakeKernel({
        "POST /browsers": {
          status: 429,
          body: { code: "org_limit_exceeded", message: "Concurrent browser limit reached." },
        },
      });
      const error = yield* Effect.flip(
        api.createBrowser({
          stealth: true,
          headless: true,
          timeout_seconds: 600,
          profile: { name: "sb-abc", save_changes: true },
          tags: {},
        }),
      );
      expect(error).toMatchObject({
        operation: "createBrowser",
        status: 429,
        code: "org_limit_exceeded",
        message: "Concurrent browser limit reached.",
      });
    }),
  );
});
