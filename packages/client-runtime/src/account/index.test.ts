import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  AccountClient,
  AccountHandoffError,
  buildAccountAuthorizeUrl,
  isAccountHandoffError,
  isAccountHttpStatusError,
  isAccountRequestTimeoutError,
  layer as accountClientLayer,
  parseAccountReturn,
  redeemAccountHandoff,
  useAccountClient,
} from "./index.ts";

const withHttpClient = (client: HttpClient.HttpClient) =>
  accountClientLayer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)));

const withResponse = (response: (request: HttpClientRequest.HttpClientRequest) => Response) =>
  withHttpClient(
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, response(request))),
    ),
  );

describe("AccountClient", () => {
  it.effect("reads and validates an account session", () =>
    Effect.gen(function* () {
      const client = yield* AccountClient;
      const session = yield* client.fetchSession({ origin: "https://accounts.example/" });

      expect(session).toEqual({ enabled: true, providers: ["email"], account: null });
    }).pipe(
      Effect.provide(
        withResponse(() => Response.json({ enabled: true, providers: ["email"], account: null })),
      ),
    ),
  );

  it.effect("returns a typed status failure for a rejected session", () =>
    Effect.gen(function* () {
      const client = yield* AccountClient;
      const error = yield* client
        .fetchSession({ origin: "https://accounts.example" })
        .pipe(Effect.flip);

      expect(isAccountHttpStatusError(error)).toBe(true);
      expect(error).toMatchObject({ operation: "session", status: 401 });
    }).pipe(Effect.provide(withResponse(() => new Response(null, { status: 401 })))),
  );

  it.effect("times out a stalled HTTP request as a typed failure", () =>
    Effect.gen(function* () {
      const client = yield* AccountClient;
      const fiber = yield* Effect.forkChild(
        client
          .fetchSession({ origin: "https://accounts.example", timeoutMs: 500 })
          .pipe(Effect.flip),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("500 millis");
      const error = yield* Fiber.join(fiber);

      expect(isAccountRequestTimeoutError(error)).toBe(true);
      expect(error).toMatchObject({ operation: "session", timeoutMs: 500 });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(withHttpClient(HttpClient.make(() => Effect.never)), TestClock.layer()),
      ),
    ),
  );

  it.effect("keeps the GitHub connect endpoint and bearer request", () => {
    const requests: HttpClientRequest.HttpClientRequest[] = [];
    return Effect.gen(function* () {
      const client = yield* useAccountClient((service) =>
        service.startGitHubNativeConnect({
          origin: "https://cloud.example/",
          token: "token-1",
          returnUrl: "signalbox://account-return",
        }),
      );

      expect(client).toBe("https://cloud.example/api/github/connect/one-time");
      expect(requests[0]?.method).toBe("POST");
      expect(requests[0]?.url).toBe("https://cloud.example/api/github/connect");
      expect(requests[0]?.headers.authorization).toBe("Bearer token-1");
    }).pipe(
      Effect.provide(
        withHttpClient(
          HttpClient.make((request) => {
            requests.push(request);
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({ url: "https://cloud.example/api/github/connect/one-time" }),
              ),
            );
          }),
        ),
      ),
    );
  });

  it.effect("maps handoff refusals to account sign-in codes", () =>
    Effect.gen(function* () {
      const client = yield* AccountClient;
      const error = yield* client
        .redeemHandoff({
          origin: "https://accounts.example",
          request: { handoff: "h", verifier: "v" },
        })
        .pipe(Effect.flip);

      expect(isAccountHandoffError(error)).toBe(true);
      expect(error).toMatchObject({ code: "expired" });
    }).pipe(
      Effect.provide(withResponse(() => Response.json({ error: "expired" }, { status: 400 }))),
    ),
  );

  it.effect("reports sign-out HTTP failures", () =>
    Effect.gen(function* () {
      const client = yield* AccountClient;
      const error = yield* client
        .signOut({ origin: "https://accounts.example", credentials: "omit" })
        .pipe(Effect.flip);

      expect(isAccountHttpStatusError(error)).toBe(true);
      expect(error).toMatchObject({ operation: "sign-out", status: 503 });
    }).pipe(Effect.provide(withResponse(() => new Response(null, { status: 503 })))),
  );

  it.effect("decodes email verification responses", () =>
    Effect.gen(function* () {
      const client = yield* AccountClient;
      const result = yield* client.verifyEmailCode({
        origin: "https://accounts.example",
        request: { verify: "v-1", code: "123456" },
      });

      expect(result).toEqual({ ok: false, body: { error: "invalid-code" } });
    }).pipe(
      Effect.provide(withResponse(() => Response.json({ error: "invalid-code" }, { status: 400 }))),
    ),
  );
});

describe("redeemAccountHandoff compatibility API", () => {
  const redeemWith = (status: number, body: unknown) =>
    redeemAccountHandoff(
      "http://127.0.0.1:1",
      { handoff: "h", verifier: "v" },
      { fetch: async () => new Response(JSON.stringify(body), { status }) },
    ).then(
      () => "ok",
      (error: unknown) => (isAccountHandoffError(error) ? error.code : "other"),
    );

  it("maps refusals to sign-in error codes", async () => {
    expect(await redeemWith(404, { error: "not_found" })).toBe("expired");
    expect(await redeemWith(400, { error: "expired" })).toBe("expired");
    expect(await redeemWith(400, { error: "bogus" })).toBe("failed");
    expect(isAccountHandoffError(new AccountHandoffError({ code: "failed" }))).toBe(true);
  });
});

describe("buildAccountAuthorizeUrl", () => {
  it("targets the server origin and drops empty params", () => {
    const url = new URL(
      buildAccountAuthorizeUrl({
        provider: "email",
        origin: "https://box.example.ts.net/",
        mode: "browser",
        loginHint: "a+b@example.com",
        returnTo: "",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://box.example.ts.net/api/account/authorize");
    expect(url.searchParams.get("loginHint")).toBe("a+b@example.com");
    expect(url.searchParams.has("returnTo")).toBe(false);
  });
});

describe("parseAccountReturn", () => {
  it("reads a native handoff", () => {
    expect(parseAccountReturn("signalbox://app/account-return?handoff=abc")).toEqual({
      _tag: "handoff",
      handoff: "abc",
    });
  });

  it("keeps known errors", () => {
    expect(parseAccountReturn("http://localhost:5733/sign-in?error=cancelled")).toEqual({
      _tag: "error",
      error: "cancelled",
    });
  });

  it("collapses unknown errors to failed and ignores unrelated urls", () => {
    expect(parseAccountReturn("signalbox://app/account-return?error=nope")).toEqual({
      _tag: "error",
      error: "failed",
    });
    expect(parseAccountReturn("http://localhost/sign-in")).toBeNull();
  });
});
