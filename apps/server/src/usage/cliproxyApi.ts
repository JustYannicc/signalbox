import * as NodeCrypto from "node:crypto";

import {
  ProviderDriverKind,
  UsageLimitSourceError,
  type ProviderConsumeResetCreditResult,
  type UsageLimitSourceAccount,
  type UsageLimitSourceConfig,
  type UsageLimitSourceUpdateAccountInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { codexPlanLabel } from "../provider/CodexProvider.ts";
import { codexRateLimitsToLimits } from "../provider/codexUsageLimits.ts";
import { claudeUsageResponseToLimits } from "../provider/claudeUsageLimits.ts";
import { makeUnavailableUsageLimits, makeUsageLimits } from "../provider/providerUsageLimits.ts";
import { grokUsageResponseToLimits } from "../provider/grokUsageLimits.ts";
import { isSignedOutAuthFile } from "../accountHub/accountHubManagement.ts";
import {
  HubProviderRateLimited,
  RATE_LIMITED_DETAIL,
  isHubProviderRateLimited,
  makeHubProbeCache,
} from "./hubProbeCache.ts";
import {
  HUB_CLAUDE_HEADERS,
  HUB_CLAUDE_USAGE_URL,
  consumeHubClaude,
  hubClaudeUsageExtras,
} from "./hubClaude.ts";

const AuthFile = Schema.Struct({
  id: Schema.String,
  auth_index: Schema.String,
  provider: Schema.String,
  email: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
  status: Schema.optional(Schema.String),
  unavailable: Schema.optional(Schema.Boolean),
  next_retry_after: Schema.optional(Schema.Unknown),
  project_id: Schema.optional(Schema.String),
  id_token: Schema.optional(
    Schema.Struct({
      chatgpt_account_id: Schema.optional(Schema.String),
      chatgpt_plan_type: Schema.optional(Schema.String),
    }),
  ),
});
const AuthFiles = Schema.Struct({ files: Schema.Array(AuthFile) });
const ApiResponse = Schema.Struct({ status_code: Schema.Number, body: Schema.String });
const CodexWindow = Schema.Struct({
  used_percent: Schema.Number,
  reset_at: Schema.optional(Schema.NullOr(Schema.Number)),
  limit_window_seconds: Schema.optional(Schema.Number),
});
const CodexUsage = Schema.Struct({
  plan_type: Schema.optional(Schema.String),
  rate_limit: Schema.NullOr(
    Schema.Struct({
      primary_window: Schema.optional(Schema.NullOr(CodexWindow)),
      secondary_window: Schema.optional(Schema.NullOr(CodexWindow)),
    }),
  ),
});
const ClaudeWindow = Schema.Struct({
  utilization: Schema.Number,
  resets_at: Schema.NullOr(Schema.String),
});
const ClaudeUsage = Schema.Struct({
  five_hour: Schema.optional(Schema.NullOr(ClaudeWindow)),
  seven_day: Schema.optional(Schema.NullOr(ClaudeWindow)),
  limits: Schema.optional(
    Schema.Array(
      Schema.Struct({
        kind: Schema.String,
        percent: Schema.optional(Schema.NullOr(Schema.Number)),
        resets_at: Schema.optional(Schema.NullOr(Schema.String)),
        scope: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              model: Schema.optional(Schema.NullOr(Schema.Struct({ display_name: Schema.String }))),
            }),
          ),
        ),
      }),
    ),
  ),
});
const CreditList = Schema.Struct({
  credits: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      reset_type: Schema.String,
      expires_at: Schema.String,
    }),
  ),
});

const decodeAuthFiles = Schema.decodeUnknownEffect(AuthFiles);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeApiResponse = Schema.decodeUnknownEffect(ApiResponse);
const decodeCreditList = Schema.decodeUnknownEffect(Schema.fromJsonString(CreditList));
const decodeClaudeUsage = Schema.decodeUnknownEffect(ClaudeUsage);
const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeCodexUsage = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexUsage));
const isUsageLimitSourceError = Schema.is(UsageLimitSourceError);
const decodeConsumeResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      code: Schema.Literals(["reset", "nothing_to_reset", "no_credit", "already_redeemed"]),
    }),
  ),
);

// signalbox: accounts from Signalbox's Sign in with ChatGPT plugin run Codex too.
const CHATGPT_SIWC = "chatgpt-siwc";
const SUPPORTED_PROVIDERS = new Set(["codex", "claude", CHATGPT_SIWC, "xai", "antigravity"]);

// signalbox: the hub's provider names, mapped to the T3 harness that runs each account.
const DRIVER_BY_PROVIDER: Record<string, string> = {
  codex: "codex",
  [CHATGPT_SIWC]: "codex",
  claude: "claudeAgent",
  xai: "grok",
  antigravity: "antigravity",
};
const driverForProvider = (provider: string) =>
  ProviderDriverKind.make(DRIVER_BY_PROVIDER[provider] ?? "codex");

const needsSignIn = isSignedOutAuthFile; // signalbox

const notProbed = (
  account: typeof AuthFile.Type,
  checkedAt: string,
  message: string,
  externalUsage?: { readonly label: string; readonly url: string },
): UsageLimitSourceAccount => ({
  id: account.id,
  driver: driverForProvider(account.provider),
  ...(account.email ? { email: account.email } : {}),
  ...(account.provider === CHATGPT_SIWC ? { plan: "ChatGPT" } : {}),
  ...(account.disabled ? { disabled: true } : {}),
  usageLimits: {
    ...makeUnavailableUsageLimits({ checkedAt, reason: "unsupported", message }),
    ...(externalUsage ? { externalUsage } : {}),
  },
});

const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const GrokUsage = Schema.Struct({
  config: Schema.optional(
    Schema.Struct({
      creditUsagePercent: Schema.optional(Schema.Number),
      currentPeriod: Schema.optional(
        Schema.Struct({
          type: Schema.optional(Schema.String),
          end: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
});
const decodeGrokUsage = Schema.decodeUnknownEffect(Schema.fromJsonString(GrokUsage));

// The quota host and client identity CLIProxyAPI's own Management Center uses.
const ANTIGRAVITY_QUOTA_URLS = [
  "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
  "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary",
  "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
];
const ANTIGRAVITY_USER_AGENT = "antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)";
const AntigravityQuota = Schema.Struct({
  groups: Schema.optional(
    Schema.Array(
      Schema.Struct({
        displayName: Schema.optional(Schema.String),
        buckets: Schema.optional(
          Schema.Array(
            Schema.Struct({
              bucketId: Schema.optional(Schema.String),
              displayName: Schema.optional(Schema.String),
              window: Schema.optional(Schema.String),
              resetTime: Schema.optional(Schema.String),
              remainingFraction: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
            }),
          ),
        ),
      }),
    ),
  ),
});
const decodeAntigravityQuota = Schema.decodeUnknownEffect(Schema.fromJsonString(AntigravityQuota));

/** One window per quota bucket, labelled by its group when there are several. */
function antigravityQuotaToLimits(quota: typeof AntigravityQuota.Type, checkedAt: string) {
  const groups = quota.groups ?? [];
  const windows = groups.flatMap((group, groupIndex) =>
    (group.buckets ?? []).flatMap((bucket, bucketIndex) => {
      const remaining = Number(bucket.remainingFraction);
      if (!Number.isFinite(remaining)) return [];
      const name = bucket.displayName ?? bucket.window ?? "Quota";
      const window = (bucket.window ?? "").toLowerCase();
      return [
        {
          id: bucket.bucketId ?? `${groupIndex}:${bucketIndex}`,
          kind: window.includes("week")
            ? ("weekly" as const)
            : window.includes("h") || window.includes("session")
              ? ("session" as const)
              : ("other" as const),
          label: groups.length > 1 && group.displayName ? `${group.displayName} · ${name}` : name,
          usedPercent: Math.round(Math.max(0, Math.min(1, 1 - remaining)) * 100),
          ...(bucket.resetTime ? { resetsAt: bucket.resetTime } : {}),
        },
      ];
    }),
  );
  return makeUsageLimits({ checkedAt, windows });
}

const CODEX_BASE = "https://chatgpt.com/backend-api/wham";
const CREDIT_URL = `${CODEX_BASE}/rate-limit-reset-credits`;

// UUIDv5 per account and credit also deduplicates retries across T3 environments.
export function creditRedeemRequestId(accountId: string, creditId: string): string {
  const bytes = NodeCrypto.createHash("sha1")
    .update(Buffer.from("6f1c2a9e2d4b4c1e9a7f3b8d5e0c1a42", "hex"))
    .update(`${accountId}:${creditId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const makeCliproxyApi = Effect.gen(function* () {
  const probes = yield* makeHubProbeCache; // signalbox
  const probeKey = (config: UsageLimitSourceConfig, accountId: string) =>
    `${config.url}:${accountId}`;
  const client = yield* HttpClient.HttpClient;

  const management = Effect.fn("CliproxyApi.management")(function* (
    config: UsageLimitSourceConfig,
    path: string,
    options: { readonly body?: unknown; readonly method?: "PATCH" | "DELETE" } = {},
  ) {
    const { body, method } = options;
    const url = yield* Effect.try({
      try: () => new URL(`/v0/management/${path}`, config.url).toString(),
      catch: () => new UsageLimitSourceError({ detail: "The hub URL is not valid." }),
    });
    const request = (
      method
        ? HttpClientRequest.make(method)(url)
        : body === undefined
          ? HttpClientRequest.get(url)
          : HttpClientRequest.post(url)
    ).pipe(HttpClientRequest.setHeader("Authorization", `Bearer ${config.managementKey}`));
    const response = yield* client
      .execute(body === undefined ? request : request.pipe(HttpClientRequest.bodyJsonUnsafe(body)))
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.timeout("15 seconds"),
        Effect.mapError(
          () => new UsageLimitSourceError({ detail: "The hub management request failed." }),
        ),
      );
    return response;
  });

  const authFiles = Effect.fn("CliproxyApi.authFiles")(function* (config: UsageLimitSourceConfig) {
    const response = yield* management(config, "auth-files");
    return (yield* decodeAuthFiles(response)).files;
  });

  const apiCall = Effect.fn("CliproxyApi.apiCall")(function* (
    config: UsageLimitSourceConfig,
    account: typeof AuthFile.Type,
    url: string,
    data?: unknown,
  ) {
    const header =
      account.provider === "xai"
        ? { Authorization: "Bearer $TOKEN$" }
        : account.provider === "antigravity"
          ? {
              Authorization: "Bearer $TOKEN$",
              "Content-Type": "application/json",
              "User-Agent": ANTIGRAVITY_USER_AGENT,
            }
          : account.provider === "codex"
            ? {
                Authorization: "Bearer $TOKEN$",
                "Content-Type": "application/json",
                "OpenAI-Beta": "codex-1",
                Originator: "Codex Desktop",
                ...(account.id_token?.chatgpt_account_id
                  ? { "Chatgpt-Account-Id": account.id_token.chatgpt_account_id }
                  : {}),
              }
            : HUB_CLAUDE_HEADERS; // signalbox: Claude reports banked resets only to its CLI
    const raw = yield* management(config, "api-call", {
      body: {
        auth_index: account.auth_index,
        method: data === undefined ? "GET" : "POST",
        url,
        header,
        ...(data === undefined ? {} : { data: yield* encodeJson(data) }),
      },
    });
    const response = yield* decodeApiResponse(raw);
    if (response.status_code === 429) {
      return yield* new HubProviderRateLimited({ detail: RATE_LIMITED_DETAIL });
    }
    if (response.status_code < 200 || response.status_code >= 300) {
      return yield* new UsageLimitSourceError({
        detail: `The provider refused the hub request (HTTP ${response.status_code}).`,
      });
    }
    return response.body;
  });

  const credits = Effect.fn("CliproxyApi.credits")(function* (
    config: UsageLimitSourceConfig,
    account: typeof AuthFile.Type,
  ) {
    const body = yield* apiCall(config, account, CREDIT_URL);
    const response = yield* decodeCreditList(body);
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    return response.credits
      .filter(
        (credit) =>
          credit.reset_type === "codex_rate_limits" &&
          credit.status === "available" &&
          Date.parse(credit.expires_at) > now,
      )
      .toSorted((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at));
  });

  const readAccount = Effect.fn("CliproxyApi.readAccount")(function* (
    config: UsageLimitSourceConfig,
    account: typeof AuthFile.Type,
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const base = {
      id: account.id,
      driver: driverForProvider(account.provider),
      ...(account.email ? { email: account.email } : {}),
    };
    const read = Effect.gen(function* () {
      // signalbox: Grok and Antigravity accounts the hub pools.
      if (account.provider === "xai") {
        const body = yield* apiCall(config, account, GROK_BILLING_URL);
        return {
          ...base,
          plan: "Grok",
          usageLimits: grokUsageResponseToLimits(yield* decodeGrokUsage(body), checkedAt),
        };
      }
      if (account.provider === "antigravity") {
        if (!account.project_id) {
          return yield* new UsageLimitSourceError({ detail: "No Antigravity project." });
        }
        const data = { project: account.project_id };
        // Google serves the quota from one of several hosts; the first that answers wins.
        const body = yield* Effect.firstSuccessOf(
          ANTIGRAVITY_QUOTA_URLS.map((url) => apiCall(config, account, url, data)),
        );
        return {
          ...base,
          plan: "Antigravity",
          usageLimits: antigravityQuotaToLimits(yield* decodeAntigravityQuota(body), checkedAt),
        };
      }
      if (account.provider === "claude") {
        const raw = yield* parseJson(yield* apiCall(config, account, HUB_CLAUDE_USAGE_URL));
        const usage = yield* decodeClaudeUsage(raw);
        const model_scoped = (usage.limits ?? []).flatMap((limit) =>
          limit.kind === "weekly_scoped" && limit.scope?.model && typeof limit.percent === "number"
            ? [
                {
                  display_name: limit.scope.model.display_name,
                  utilization: limit.percent,
                  resets_at: limit.resets_at ?? null,
                },
              ]
            : [],
        );
        const limits = claudeUsageResponseToLimits({
          checkedAt,
          response: {
            rate_limits_available: true,
            rate_limits: {
              five_hour: usage.five_hour ?? null,
              seven_day: usage.seven_day ?? null,
              model_scoped,
            },
          },
        }).limits;
        const extras = hubClaudeUsageExtras(
          raw,
          limits.windows,
          DateTime.toEpochMillis(yield* DateTime.now),
        );
        return {
          ...base,
          plan: extras.plan ?? "Claude Subscription",
          usageLimits: {
            ...limits,
            ...(extras.resetCredits ? { resetCredits: extras.resetCredits } : {}),
          },
        };
      }
      const body = yield* apiCall(config, account, `${CODEX_BASE}/usage`);
      const usage = yield* decodeCodexUsage(body);
      const toWindow = (window: typeof CodexWindow.Type | null | undefined) =>
        window
          ? {
              usedPercent: window.used_percent,
              resetsAt: window.reset_at ?? null,
              ...(window.limit_window_seconds === undefined
                ? {}
                : { windowDurationMins: window.limit_window_seconds / 60 }),
            }
          : null;
      // A credits outage must not hide successfully fetched quota windows.
      const available = yield* credits(config, account).pipe(Effect.orElseSucceed(() => undefined));
      const next = available?.[0];
      return {
        ...base,
        plan: codexPlanLabel(usage.plan_type ?? account.id_token?.chatgpt_plan_type),
        usageLimits: {
          ...codexRateLimitsToLimits({
            checkedAt,
            snapshot: {
              planType: usage.plan_type ?? null,
              primary: toWindow(usage.rate_limit?.primary_window),
              secondary: toWindow(usage.rate_limit?.secondary_window),
            },
          }),
          ...(available
            ? {
                resetCredits: {
                  availableCount: available.length,
                  ...(next
                    ? {
                        nextCreditId: next.id,
                        nextExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(next.expires_at)),
                      }
                    : {}),
                },
              }
            : {}),
        },
      };
    });
    return yield* probes.read(probeKey(config, account.id), read).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          ...base,
          usageLimits: makeUnavailableUsageLimits({
            checkedAt,
            reason: "probeFailed",
            message: isHubProviderRateLimited(error)
              ? error.detail
              : "The hub could not read this account's usage.",
          }),
        }),
      ),
    );
  });

  const readAccounts = Effect.fn("CliproxyApi.readAccounts")(function* (
    config: UsageLimitSourceConfig,
  ): Effect.fn.Return<ReadonlyArray<UsageLimitSourceAccount>, UsageLimitSourceError> {
    const accounts = yield* authFiles(config).pipe(
      Effect.mapError(
        () => new UsageLimitSourceError({ detail: "The hub could not list accounts." }),
      ),
    );
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return yield* Effect.forEach(
      accounts.filter((account) => SUPPORTED_PROVIDERS.has(account.provider)),
      (account) =>
        // Paused accounts are listed so they can be resumed, without spending a usage probe.
        account.disabled
          ? Effect.succeed(notProbed(account, checkedAt, "Paused."))
          : needsSignIn(account)
            ? Effect.succeed({
                ...notProbed(account, checkedAt, "Signed out. Sign in again."),
                signedOut: true,
              })
            : account.provider === CHATGPT_SIWC
              ? Effect.succeed(
                  notProbed(
                    account,
                    checkedAt,
                    "ChatGPT does not share usage with connected apps.",
                    {
                      label: "ChatGPT usage",
                      url: "https://chatgpt.com/#settings/Usage",
                    },
                  ),
                )
              : readAccount(config, account),
      { concurrency: 4 },
    );
  });

  // The hub answers an unknown name with an error status, so there is no list-then-act race.
  const updateAccount = Effect.fn("CliproxyApi.updateAccount")(function* (
    config: UsageLimitSourceConfig,
    accountId: string,
    action: UsageLimitSourceUpdateAccountInput["action"],
  ) {
    yield* (
      action === "remove"
        ? management(config, `auth-files?name=${encodeURIComponent(accountId)}`, {
            method: "DELETE",
          })
        : management(config, "auth-files/status", {
            method: "PATCH",
            body: { name: accountId, disabled: action === "pause" },
          })
    ).pipe(
      Effect.mapError(
        () =>
          new UsageLimitSourceError({
            detail: "The hub could not update this account. Refresh and try again.",
          }),
      ),
    );
    yield* probes.expire(probeKey(config, accountId)); // signalbox: a resumed account reads fresh
  });

  const consumeCodex = Effect.fn("CliproxyApi.consumeCodex")(function* (
    config: UsageLimitSourceConfig,
    account: typeof AuthFile.Type,
    creditId: string,
  ) {
    const body = yield* apiCall(config, account, `${CREDIT_URL}/consume`, {
      redeem_request_id: creditRedeemRequestId(
        account.id_token?.chatgpt_account_id ?? account.id,
        creditId,
      ),
      credit_id: creditId,
    });
    const response = yield* decodeConsumeResponse(body);
    return (
      {
        reset: "reset",
        nothing_to_reset: "nothingToReset",
        no_credit: "noCredit",
        already_redeemed: "alreadyRedeemed",
      } as const
    )[response.code];
  });

  const consume = Effect.fn("CliproxyApi.consume")(function* (
    config: UsageLimitSourceConfig,
    accountId: string,
    creditId: string,
  ): Effect.fn.Return<ProviderConsumeResetCreditResult, UsageLimitSourceError> {
    const operation = Effect.gen(function* () {
      const account = (yield* authFiles(config)).find((account) => account.id === accountId);
      if (
        !account ||
        account.disabled ||
        (account.provider !== "codex" && account.provider !== "claude")
      ) {
        return yield* new UsageLimitSourceError({
          detail: "The hub account is missing or disabled.",
        });
      }
      const outcome = yield* (
        account.provider === "claude"
          ? consumeHubClaude(
              (url, data) => apiCall(config, account, url, data),
              creditId,
              creditRedeemRequestId(account.id, creditId),
            )
          : consumeCodex(config, account, creditId)
      ).pipe(
        // The credit may be spent even when the answer is lost; the next read checks.
        Effect.ensuring(probes.expire(probeKey(config, account.id))),
      );
      if (outcome !== "reset" && outcome !== "alreadyRedeemed") return { outcome };
      const cleared = yield* management(config, "reset-quota", {
        body: { auth_index: account.auth_index },
      }).pipe(Effect.result);
      return {
        outcome,
        ...(cleared._tag === "Failure"
          ? {
              warning:
                "Credit redeemed, but the hub cooldown could not be cleared. Routing may resume after its cooldown expires.",
            }
          : {}),
      } as const;
    });
    return yield* operation.pipe(
      Effect.mapError((error) =>
        isUsageLimitSourceError(error)
          ? error
          : new UsageLimitSourceError({
              detail: isHubProviderRateLimited(error)
                ? "The provider is rate limiting requests. Try again in a few minutes."
                : "The hub returned an unexpected reset-credit response.",
            }),
      ),
    );
  });
  return { readAccounts, consume, updateAccount };
});
