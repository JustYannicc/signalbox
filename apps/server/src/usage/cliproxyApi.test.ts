import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import { creditRedeemRequestId, makeCliproxyApi } from "./cliproxyApi.ts";

const config = {
  kind: "cliproxy",
  url: "http://hub.test:8317",
  managementKey: "management-secret",
  enabled: true,
} as const;
const accounts = [
  {
    id: "first.json",
    auth_index: "a",
    provider: "codex",
    email: "first@example.com",
    id_token: { chatgpt_account_id: "account-a" },
  },
  {
    id: "second.json",
    auth_index: "b",
    provider: "codex",
    email: "second@example.com",
    id_token: { chatgpt_account_id: "account-b" },
  },
];
const credit = (id: string, expires_at = "2099-01-01T00:00:00Z") => ({
  id,
  expires_at,
  status: "available",
  reset_type: "codex_rate_limits",
});
const RequestBody = Schema.Struct({
  auth_index: Schema.String,
  method: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  header: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  data: Schema.optional(Schema.String),
});
type RequestBody = typeof RequestBody.Type;
const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(RequestBody));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function fixture(
  options: {
    accounts?: Array<
      Omit<(typeof accounts)[number], "id_token"> & {
        disabled?: boolean;
        status?: string;
        unavailable?: boolean;
        next_retry_after?: string;
        project_id?: string;
        id_token?: (typeof accounts)[number]["id_token"];
      }
    >;
    upstream?: (request: RequestBody) => { status: number; body: unknown };
    cooldownStatus?: number;
  } = {},
) {
  const requests: Array<{ method: string; path: string; search: string; body?: RequestBody }> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      expect(request.headers.authorization).toBe("Bearer management-secret");
      const { pathname: path, search } = new URL(request.url);
      const body =
        request.body._tag === "Uint8Array" && !path.endsWith("/auth-files/status")
          ? decodeRequest(new TextDecoder().decode(request.body.body))
          : undefined;
      requests.push({ method: request.method, path, search, ...(body ? { body } : {}) });
      if (path.endsWith("/auth-files/status") || request.method === "DELETE")
        return HttpClientResponse.fromWeb(
          request,
          Response.json(search.includes("gone") ? { error: "not found" } : { status: "ok" }, {
            status: search.includes("gone") ? 404 : 200,
          }),
        );
      if (path.endsWith("/auth-files"))
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ files: options.accounts ?? accounts }),
        );
      if (path.endsWith("/reset-quota"))
        return HttpClientResponse.fromWeb(
          request,
          Response.json({}, { status: options.cooldownStatus ?? 200 }),
        );
      expect(path).toBe("/v0/management/api-call");
      expect(body?.header?.Authorization).toBe("Bearer $TOKEN$");
      const upstream = options.upstream?.(body!) ?? {
        status: 200,
        body: body?.url?.endsWith("/consume")
          ? { code: "reset" }
          : body?.url?.endsWith("/rate-limit-reset-credits")
            ? {
                credits: [
                  credit("later", "2099-02-01T00:00:00Z"),
                  credit("first"),
                  credit("expired", "2000-01-01T00:00:00Z"),
                  { ...credit("used"), status: "redeemed" },
                ],
              }
            : {
                plan_type: "pro",
                rate_limit: {
                  secondary_window: {
                    used_percent: 78,
                    reset_at: 4070908800,
                    limit_window_seconds: 604800,
                  },
                },
              },
      };
      return HttpClientResponse.fromWeb(
        request,
        Response.json({ status_code: upstream.status, body: encodeJson(upstream.body) }),
      );
    }),
  );
  return {
    requests,
    api: makeCliproxyApi.pipe(Effect.provideService(HttpClient.HttpClient, http)),
  };
}

describe("CLIProxyAPI built-in management API", () => {
  it.effect(
    "reads both accounts and their earliest unexpired credits without plugin endpoints",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1788710400000);
        const test = fixture();
        const api = yield* test.api;
        const result = yield* api.readAccounts(config);
        expect(result.map((account) => account.usageLimits.resetCredits)).toEqual([
          { availableCount: 2, nextCreditId: "first", nextExpiresAt: "2099-01-01T00:00:00.000Z" },
          { availableCount: 2, nextCreditId: "first", nextExpiresAt: "2099-01-01T00:00:00.000Z" },
        ]);
        expect(result[0]?.usageLimits.windows).toMatchObject([
          { id: "secondary", usedPercent: 78, kind: "weekly" },
        ]);
        const calls = test.requests.filter((request) => request.body?.url);
        expect(calls.map((request) => request.body?.auth_index).sort()).toEqual([
          "a",
          "a",
          "b",
          "b",
        ]);
        expect(
          calls.find((request) => request.body?.auth_index === "b")?.body?.header?.[
            "Chatgpt-Account-Id"
          ],
        ).toBe("account-b");
      }),
  );

  it.effect("keeps usage when the credits endpoint fails", () =>
    Effect.gen(function* () {
      const test = fixture({
        upstream: (request) =>
          request.url?.endsWith("rate-limit-reset-credits")
            ? { status: 503, body: { token: "do-not-publish" } }
            : { status: 200, body: { rate_limit: { primary_window: { used_percent: 12 } } } },
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(result[0]?.usageLimits.windows[0]?.usedPercent).toBe(12);
      expect(result[0]?.usageLimits.resetCredits).toBeUndefined();
    }),
  );

  it.effect("isolates a failed account and never publishes upstream error bodies", () =>
    Effect.gen(function* () {
      const test = fixture({
        upstream: (request) =>
          request.auth_index === "a"
            ? { status: 401, body: { token: "do-not-publish" } }
            : {
                status: 200,
                body: request.url?.endsWith("rate-limit-reset-credits")
                  ? { credits: [] }
                  : { rate_limit: { primary_window: { used_percent: 12 } } },
              },
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(result[0]?.usageLimits.unavailable?.reason).toBe("probeFailed");
      expect(result[1]?.usageLimits.windows[0]?.usedPercent).toBe(12);
      expect(encodeJson(result)).not.toContain("do-not-publish");
    }),
  );

  it.effect("maps Claude scoped windows without a scheduler plugin", () =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [{ ...accounts[0]!, provider: "claude" }],
        upstream: () => ({
          status: 200,
          body: {
            five_hour: { utilization: 10, resets_at: null },
            seven_day: { utilization: 50, resets_at: "2099-01-01T00:00:00Z" },
            limits: [
              {
                kind: "weekly_scoped",
                percent: 80,
                resets_at: null,
                scope: { model: { display_name: "Fable" } },
              },
            ],
          },
        }),
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(
        result[0]?.usageLimits.windows.map((window) => [window.id, window.usedPercent]),
      ).toEqual([
        ["five_hour", 10],
        ["seven_day", 50],
        ["seven_day_fable", 80],
      ]);
    }),
  );

  it.effect("reads and redeems a Claude banked reset as the Claude CLI", () =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [{ ...accounts[0]!, provider: "claude" }],
        upstream: (request) => {
          expect(request.header?.["User-Agent"]).toMatch(/^claude-cli\//);
          if (request.url?.endsWith("/api/oauth/profile")) {
            return { status: 200, body: { organization: { uuid: "org-1" } } };
          }
          if (request.url?.endsWith("/reset_rate_limits"))
            return { status: 200, body: { result: "reset" } };
          return {
            status: 200,
            body: {
              five_hour: { utilization: 10, resets_at: null },
              cedar_ember: {
                eligible: true,
                grants: [
                  {
                    id: "launch-grant",
                    resets_left: 1,
                    ends_at: "2099-01-01T00:00:00+00:00",
                    paused: false,
                    usable_now: true,
                    clears: ["five_hour", "seven_day", "seven_day_overage_included"],
                  },
                  {
                    id: "session-grant",
                    resets_left: 1,
                    ends_at: "2099-02-01T00:00:00+00:00",
                    paused: false,
                    usable_now: true,
                    clears: ["five_hour"],
                  },
                ],
                next_grant_id: "launch-grant",
                event_props: { tier: "claude_max_20x" },
              },
            },
          };
        },
      });
      const api = yield* test.api;
      const [account] = yield* api.readAccounts(config);
      expect(account?.plan).toBe("Claude Max 20x Subscription");
      const credits = account?.usageLimits.resetCredits;
      expect(credits?.availableCount).toBe(2);
      // Nothing is at its limit, so a plain "Use reset" would take the narrowest grant.
      expect(credits?.nextCreditId).toBe("session-grant");
      // A 5-hour ticket spends the 5-hour reset and keeps the full one for the weekly window.
      expect(credits?.windows?.find((entry) => entry.windowId === "five_hour")).toEqual({
        windowId: "five_hour",
        availableCount: 2,
        nextCreditId: "session-grant",
        // The soonest expiry among the window's credits, not the claimed one's.
        nextExpiresAt: "2099-01-01T00:00:00.000Z",
      });
      expect(credits?.windows?.find((entry) => entry.windowId === "seven_day")).toEqual({
        windowId: "seven_day",
        availableCount: 1,
        nextCreditId: "launch-grant",
        nextExpiresAt: "2099-01-01T00:00:00.000Z",
      });
      expect(yield* api.consume(config, account!.id, "launch-grant")).toEqual({ outcome: "reset" });
      const claim = test.requests.find((request) =>
        request.body?.url?.endsWith("/api/organizations/org-1/reset_rate_limits"),
      );
      expect(claim?.body?.data).toContain('"grant_id":"launch-grant"');
      expect(test.requests.some((request) => request.path.endsWith("/reset-quota"))).toBe(true);
    }),
  );

  it.effect("pins redemption to the displayed credit and clears only that account's cooldown", () =>
    Effect.gen(function* () {
      const test = fixture();
      const api = yield* test.api;
      expect(yield* api.consume(config, "second.json", "credit-b")).toEqual({ outcome: "reset" });
      expect(yield* api.consume(config, "second.json", "credit-b")).toEqual({ outcome: "reset" });
      const redemptions = test.requests.filter((request) =>
        request.body?.url?.endsWith("/consume"),
      );
      expect(redemptions).toHaveLength(2);
      expect(redemptions[0]?.body?.data).toBe(redemptions[1]?.body?.data);
      expect(redemptions[0]?.body?.data).toBe(
        encodeJson({
          redeem_request_id: creditRedeemRequestId("account-b", "credit-b"),
          credit_id: "credit-b",
        }),
      );
      expect(
        test.requests
          .filter((request) => request.path.endsWith("/reset-quota"))
          .map((request) => request.body?.auth_index),
      ).toEqual(["b", "b"]);
    }),
  );

  it.effect.each([
    ["nothing_to_reset", "nothingToReset"],
    ["no_credit", "noCredit"],
    ["already_redeemed", "alreadyRedeemed"],
  ] as const)("reports %s accurately", ([code, outcome]) =>
    Effect.gen(function* () {
      const test = fixture({ upstream: () => ({ status: 200, body: { code } }) });
      const api = yield* test.api;
      expect(yield* api.consume(config, "first.json", "credit")).toEqual({ outcome });
      expect(test.requests.some((request) => request.path.endsWith("/reset-quota"))).toBe(
        code === "already_redeemed",
      );
    }),
  );

  it.effect("reports redemption success even if cooldown clearing fails", () =>
    Effect.gen(function* () {
      const api = yield* fixture({ cooldownStatus: 404 }).api;
      const result = yield* api.consume(config, "first.json", "credit");
      expect(result.outcome).toBe("reset");
      expect(result.warning).toContain("cooldown");
    }),
  );

  it.effect("lists paused accounts without probing them and rejects redemption on them", () =>
    Effect.gen(function* () {
      const test = fixture({ accounts: [{ ...accounts[0]!, disabled: true }] });
      const api = yield* test.api;
      const [paused, ...rest] = yield* api.readAccounts(config);
      expect(rest).toEqual([]);
      expect(paused).toMatchObject({
        id: "first.json",
        driver: "codex",
        disabled: true,
        usageLimits: { windows: [], unavailable: { reason: "unsupported" } },
      });
      expect((yield* api.consume(config, "first.json", "credit").pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(test.requests.every((request) => request.path.endsWith("/auth-files"))).toBe(true);
    }),
  );

  it.effect("lists Sign in with ChatGPT accounts as Codex without probing ChatGPT", () =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [
          {
            id: "chatgpt-siwc-a.json",
            auth_index: "s",
            provider: "chatgpt-siwc",
            email: "a@example.com",
          },
        ],
      });
      const api = yield* test.api;
      expect(yield* api.readAccounts(config)).toMatchObject([
        {
          id: "chatgpt-siwc-a.json",
          driver: "codex",
          email: "a@example.com",
          plan: "ChatGPT",
          usageLimits: {
            unavailable: { reason: "unsupported" },
            externalUsage: { url: "https://chatgpt.com/#settings/Usage" },
          },
        },
      ]);
      expect(test.requests.every((request) => request.path.endsWith("/auth-files"))).toBe(true);
    }),
  );

  it.effect("asks for a fresh sign-in when the hub reports a dead refresh token", () =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [
          {
            id: "chatgpt-siwc-a.json",
            auth_index: "s",
            provider: "chatgpt-siwc",
            email: "a@example.com",
            status: "error",
            unavailable: true,
          },
          {
            id: "cooling.json",
            auth_index: "c",
            provider: "chatgpt-siwc",
            email: "c@example.com",
            status: "error",
            unavailable: true,
            next_retry_after: "2099-01-01T00:00:00Z",
          },
        ],
      });
      const api = yield* test.api;
      const [signedOut, cooling] = yield* api.readAccounts(config);
      expect(signedOut?.usageLimits.unavailable?.message).toBe("Signed out. Sign in again.");
      expect(signedOut?.signedOut).toBe(true);
      expect(cooling?.usageLimits.unavailable?.message).not.toContain("Signed out");
      expect(cooling?.signedOut).toBeUndefined();
    }),
  );

  it.effect("reads Grok billing and Antigravity quota through the hub", () =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [
          { id: "xai-a.json", auth_index: "x", provider: "xai", email: "x@example.com" },
          {
            id: "antigravity-a.json",
            auth_index: "g",
            provider: "antigravity",
            email: "g@example.com",
            project_id: "proj-1",
          },
        ],
        upstream: (request) =>
          request.url?.includes("grok.com")
            ? {
                status: 200,
                body: {
                  config: {
                    creditUsagePercent: 40,
                    currentPeriod: {
                      type: "USAGE_PERIOD_TYPE_WEEKLY",
                      end: "2099-01-01T00:00:00Z",
                    },
                  },
                },
              }
            : request.url?.startsWith("https://daily-cloudcode-pa.googleapis.com")
              ? { status: 503, body: {} }
              : {
                  status: 200,
                  body: {
                    groups: [
                      {
                        displayName: "Gemini",
                        buckets: [
                          {
                            bucketId: "g5h",
                            displayName: "5 hours",
                            window: "5h",
                            remainingFraction: 0.25,
                            resetTime: "2099-01-01T00:00:00Z",
                          },
                        ],
                      },
                    ],
                  },
                },
      });
      const api = yield* test.api;
      const [grok, antigravity] = yield* api.readAccounts(config);
      expect(grok).toMatchObject({
        driver: "grok",
        email: "x@example.com",
        usageLimits: { windows: [{ kind: "weekly", usedPercent: 40 }] },
      });
      expect(antigravity).toMatchObject({
        driver: "antigravity",
        usageLimits: {
          windows: [{ id: "g5h", kind: "session", label: "5 hours", usedPercent: 75 }],
        },
      });
      const quotaCall = test.requests.find((request) =>
        request.body?.url?.includes("cloudcode-pa"),
      );
      expect(quotaCall?.body?.method).toBe("POST");
      expect(quotaCall?.body?.data).toBe('{"project":"proj-1"}');
    }),
  );

  it.effect("pauses, resumes, and removes accounts through the hub's auth files", () =>
    Effect.gen(function* () {
      const test = fixture();
      const api = yield* test.api;
      yield* api.updateAccount(config, "second.json", "pause");
      yield* api.updateAccount(config, "second.json", "resume");
      yield* api.updateAccount(config, "second.json", "remove");
      expect(test.requests.map(({ method, path, search }) => `${method} ${path}${search}`)).toEqual(
        [
          "PATCH /v0/management/auth-files/status",
          "PATCH /v0/management/auth-files/status",
          "DELETE /v0/management/auth-files?name=second.json",
        ],
      );
      const missing = yield* api.updateAccount(config, "gone.json", "remove").pipe(Effect.flip);
      expect(missing.detail).toContain("could not update");
    }),
  );

  it.effect("keeps the same redemption id after an uncertain upstream failure", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const test = fixture({
        upstream: () =>
          ++attempts === 1
            ? { status: 503, body: {} }
            : { status: 200, body: { code: "already_redeemed" } },
      });
      const api = yield* test.api;
      expect((yield* api.consume(config, "first.json", "credit").pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(yield* api.consume(config, "first.json", "credit")).toEqual({
        outcome: "alreadyRedeemed",
      });
      const data = test.requests
        .filter((request) => request.body?.url?.endsWith("/consume"))
        .map((request) => request.body?.data);
      expect(data[0]).toBe(data[1]);
      expect(test.requests.filter((request) => request.path.endsWith("/reset-quota"))).toHaveLength(
        1,
      );
    }),
  );

  it.effect("rejects unknown accounts without forwarding a redemption", () =>
    Effect.gen(function* () {
      const test = fixture();
      const api = yield* test.api;
      const result = yield* api.consume(config, "missing.json", "credit").pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(test.requests).toHaveLength(1);
    }),
  );
});
