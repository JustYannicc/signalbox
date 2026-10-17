import {
  ServerProviderUsageLimits as ServerProviderUsageLimitsSchema,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as CliProxyApi from "./cliProxyApi.ts";
import * as PoolUsageHistory from "./poolUsageHistory.ts";

/**
 * Each account's usage windows (5-hour, weekly, …) as a cloud pool reads
 * them, in the shape and with the window ids self-hosted pools show
 * (`apps/server/src/usage/cliproxyApi.ts`), so Limits draws both alike.
 *
 * Two sources, newest first:
 * - **Signals:** CLIProxyAPI keeps the rate-limit headers of an account's
 *   last response (`anthropic-ratelimit-unified-*`, `x-codex-*`). Free, but
 *   only there once the account has answered since the container started.
 * - **Probe:** the provider's own usage endpoint, asked as the account
 *   through `requests/api-call`. Costs a request, so `PoolEngine` spaces it.
 */

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
const MONTH_MINS = 30 * 24 * 60;

/** The account types a pool reads limits for. */
export const READS_LIMITS = new Set(["claude", "codex"]);

const isoAt = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

const isoFromEpochSeconds = (seconds: number | null | undefined) =>
  typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? isoAt(seconds * 1000)
    : undefined;

const isoFromString = (value: string | null | undefined) => {
  const at = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? isoAt(at) : undefined;
};

const limitsOf = (checkedAt: number, windows: ReadonlyArray<ServerProviderUsageWindow>) =>
  makeUsageLimits({ checkedAt: isoAt(checkedAt), windows });

const CLAUDE_WINDOWS = {
  five_hour: { kind: "session", label: "Session", windowDurationMins: SESSION_MINS, header: "5h" },
  seven_day: { kind: "weekly", label: "Weekly", windowDurationMins: WEEK_MINS, header: "7d" },
} as const;

const claudeWindow = (
  id: keyof typeof CLAUDE_WINDOWS,
  usedPercent: number,
  resetsAt: string | undefined,
): ServerProviderUsageWindow => {
  const { header: _, ...window } = CLAUDE_WINDOWS[id];
  return {
    id,
    ...window,
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
  };
};

const codexKind = (mins: number): ServerProviderUsageWindow["kind"] =>
  mins >= MONTH_MINS ? "monthly" : mins >= WEEK_MINS ? "weekly" : "session";

const codexWindow = (
  id: "primary" | "secondary",
  usedPercent: number,
  windowDurationMins: number,
  resetsAt: string | undefined,
): ServerProviderUsageWindow => {
  const kind = codexKind(windowDurationMins);
  return {
    id,
    kind,
    label: kind === "session" ? "Session" : kind === "weekly" ? "Weekly" : "Monthly",
    usedPercent: clampPercent(usedPercent),
    windowDurationMins,
    ...(resetsAt ? { resetsAt } : {}),
  };
};

/** `primary` is the 5-hour window on paid plans and the monthly one on Free and Go. */
const codexFallbackMins = (id: "primary" | "secondary", plan: string | undefined) =>
  id === "secondary" ? WEEK_MINS : plan === "free" || plan === "go" ? MONTH_MINS : SESSION_MINS;

const number = (value: string | undefined) => {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * The windows an account's last response carried, or null when it carried
 * none. Header names are matched case-insensitively.
 */
export const fromSignals = (
  type: string,
  signals: Readonly<Record<string, string>>,
  observedAt: number,
): ServerProviderUsageLimits | null => {
  const headers = new Map(
    Object.entries(signals).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const windows: ServerProviderUsageWindow[] = [];
  if (type === "claude") {
    for (const id of ["five_hour", "seven_day"] as const) {
      const prefix = `anthropic-ratelimit-unified-${CLAUDE_WINDOWS[id].header}`;
      // Utilization is a 0–1 fraction; the reset is in epoch seconds.
      const utilization = number(headers.get(`${prefix}-utilization`));
      if (utilization === undefined) continue;
      const reset = isoFromEpochSeconds(number(headers.get(`${prefix}-reset`)));
      windows.push(claudeWindow(id, utilization * 100, reset));
    }
  } else if (type === "codex") {
    const plan = headers.get("x-codex-plan-type");
    for (const id of ["primary", "secondary"] as const) {
      const used = number(headers.get(`x-codex-${id}-used-percent`));
      if (used === undefined) continue;
      const minutes = number(headers.get(`x-codex-${id}-window-minutes`));
      const mins = minutes === undefined ? codexFallbackMins(id, plan) : Math.round(minutes);
      const resetAfter = number(headers.get(`x-codex-${id}-reset-after-seconds`));
      const reset =
        isoFromEpochSeconds(number(headers.get(`x-codex-${id}-reset-at`))) ??
        (resetAfter === undefined ? undefined : isoAt(observedAt + resetAfter * 1000));
      windows.push(codexWindow(id, used, mins, reset));
    }
  }
  return windows.length === 0 ? null : limitsOf(observedAt, windows);
};

/** Anthropic's usage endpoint, as Claude Code asks it. Percentages are 0–100. */
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_HEADERS = {
  Authorization: "Bearer $TOKEN$",
  "anthropic-beta": "oauth-2025-04-20",
  "Content-Type": "application/json",
  // Claude checks the `claude-cli/` prefix, not the version.
  "User-Agent": "claude-cli/2.1.291 (external, cli)",
};
const ClaudeWindow = Schema.NullOr(
  Schema.Struct({ utilization: Schema.Number, resets_at: Schema.NullOr(Schema.String) }),
);
const ClaudeUsage = Schema.fromJsonString(
  Schema.Struct({
    five_hour: Schema.optional(ClaudeWindow),
    seven_day: Schema.optional(ClaudeWindow),
  }),
);

/** ChatGPT's usage endpoint, as the Codex app asks it. */
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CodexWindow = Schema.NullOr(
  Schema.Struct({
    used_percent: Schema.Number,
    reset_at: Schema.optional(Schema.NullOr(Schema.Number)),
    limit_window_seconds: Schema.optional(Schema.Number),
  }),
);
const CodexUsage = Schema.fromJsonString(
  Schema.Struct({
    plan_type: Schema.optional(Schema.String),
    rate_limit: Schema.NullOr(
      Schema.Struct({
        primary_window: Schema.optional(CodexWindow),
        secondary_window: Schema.optional(CodexWindow),
      }),
    ),
  }),
);

/** How long a usage check may take before the account says it didn't answer. */
const PROBE_TIMEOUT = "10 seconds";

/** Why a probe got no windows; shown on the account. */
export class LimitsProbeError extends Schema.TaggedError<LimitsProbeError>()("LimitsProbeError", {
  detail: Schema.String,
}) {}

const providerName = (type: string) => (type === "claude" ? "Anthropic" : "ChatGPT");

const decodeOr = <A>(schema: Schema.Decoder<A>, type: string) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return (body: string) =>
    decode(body).pipe(
      Effect.mapError(
        () =>
          new LimitsProbeError({
            detail: `${providerName(type)} answered the usage check in a shape Signalbox doesn't know.`,
          }),
      ),
    );
};

/**
 * Asks the provider for an account's windows now. Only for `READS_LIMITS`
 * types on a CLIProxyAPI that names its accounts (`authIndex`).
 */
export const probe = (
  endpoint: CliProxyApi.PoolEndpoint,
  account: {
    readonly type: string;
    readonly authIndex: string;
    readonly chatgptAccountId: string | null;
  },
  now: number,
) =>
  Effect.gen(function* () {
    const claude = account.type === "claude";
    const answer = yield* CliProxyApi.accountGet(
      endpoint,
      account.authIndex,
      claude ? CLAUDE_USAGE_URL : CODEX_USAGE_URL,
      claude
        ? CLAUDE_HEADERS
        : {
            Authorization: "Bearer $TOKEN$",
            "Content-Type": "application/json",
            "OpenAI-Beta": "codex-1",
            Originator: "Codex Desktop",
            ...(account.chatgptAccountId ? { "Chatgpt-Account-Id": account.chatgptAccountId } : {}),
          },
    ).pipe(
      Effect.timeoutOrElse({
        duration: PROBE_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new LimitsProbeError({
              detail: `${providerName(account.type)} didn't answer the usage check in time.`,
            }),
          ),
      }),
      Effect.mapError((error) =>
        error._tag === "LimitsProbeError" ? error : new LimitsProbeError({ detail: error.detail }),
      ),
    );
    if (answer.status === 429) {
      return yield* new LimitsProbeError({
        detail: `${providerName(account.type)} is rate limiting usage checks. Trying again shortly.`,
      });
    }
    if (answer.status < 200 || answer.status >= 300) {
      return yield* new LimitsProbeError({
        detail: `${providerName(account.type)} refused the usage check (HTTP ${answer.status}).`,
      });
    }
    if (claude) {
      const usage = yield* decodeOr(ClaudeUsage, account.type)(answer.body);
      const windows = (["five_hour", "seven_day"] as const).flatMap((id) => {
        const window = usage[id];
        return window
          ? [claudeWindow(id, window.utilization, isoFromString(window.resets_at))]
          : [];
      });
      return limitsOf(now, windows);
    }
    const usage = yield* decodeOr(CodexUsage, account.type)(answer.body);
    const windows = (
      [
        ["primary", usage.rate_limit?.primary_window],
        ["secondary", usage.rate_limit?.secondary_window],
      ] as const
    ).flatMap(([id, window]) =>
      window
        ? [
            codexWindow(
              id,
              window.used_percent,
              window.limit_window_seconds === undefined
                ? codexFallbackMins(id, usage.plan_type)
                : Math.round(window.limit_window_seconds / 60),
              isoFromEpochSeconds(window.reset_at),
            ),
          ]
        : [],
    );
    return limitsOf(now, windows);
  });

/** `PoolEngine`'s `0006` migration: each account's windows as last read. */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE account_limits (
    name TEXT PRIMARY KEY,
    limits TEXT NOT NULL,
    read_at INTEGER NOT NULL,
    probed_at INTEGER NOT NULL
  )`;
});

/** How long after a probe an account is asked again, when its signals say nothing newer. */
export const PROBE_INTERVAL_MS = 10 * 60_000;

/** How many accounts are probed at once. */
const PROBE_CONCURRENCY = 4;

const LimitsJson = Schema.fromJsonString(ServerProviderUsageLimitsSchema);
const encodeLimits = Schema.encodeSync(LimitsJson);
const decodeLimits = Schema.decodeUnknownOption(LimitsJson);

interface Stored {
  readonly limits: ServerProviderUsageLimits;
  /** `limits` as stored, so an unchanged read writes nothing. */
  readonly json: string;
  /** When the windows were true: the signals' response, or the probe. */
  readonly readAt: number;
  readonly probedAt: number;
}

const storedRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly name: string;
    readonly limits: string;
    readonly read_at: number;
    readonly probed_at: number;
  }>`SELECT name, limits, read_at, probed_at FROM account_limits`;
  return new Map(
    rows.flatMap((row): Array<[string, Stored]> => {
      const limits = decodeLimits(row.limits);
      return limits._tag === "Some"
        ? [
            [
              row.name,
              {
                limits: limits.value,
                json: row.limits,
                readAt: row.read_at,
                probedAt: row.probed_at,
              },
            ],
          ]
        : [];
    }),
  );
});

/** Every account's last read windows, by account name. */
export const cached = Effect.map(
  storedRows,
  (rows): ReadonlyMap<string, ServerProviderUsageLimits> =>
    new Map([...rows].map(([name, stored]) => [name, stored.limits])),
);

/** Stores an account's read, unless it's what `before` already holds. */
const save = (name: string, next: Omit<Stored, "json">, before: Stored | undefined) =>
  Effect.gen(function* () {
    const json = encodeLimits(next.limits);
    if (
      before?.json === json &&
      before.readAt === next.readAt &&
      before.probedAt === next.probedAt
    ) {
      return;
    }
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO account_limits (name, limits, read_at, probed_at)
      VALUES (${name}, ${json}, ${next.readAt}, ${next.probedAt})
      ON CONFLICT (name) DO UPDATE SET limits = excluded.limits, read_at = excluded.read_at,
        probed_at = excluded.probed_at`;
  });

/** What one account's read did, for the span. */
type Outcome = "skipped" | "signals" | "probed" | "probeFailed" | "reported" | "cleared";

/** A cooldown the pool ended because the provider had room again. */
export interface ClearedCooldown {
  readonly name: string;
  readonly type: string;
  /** Says what the provider reported and how long the account would have waited. */
  readonly reason: string;
  /** How much longer the CLIProxyAPI would have held the account, in millis. */
  readonly heldForMs: number;
}

/** How often an account the CLIProxyAPI holds is checked with its provider. */
export const HELD_CHECK_MS = 30_000;

/** A hold ending sooner than this is waited out: checking would cost about as much. */
const HELD_WORTH_CHECKING_MS = 5 * 60_000;

/** Which reads a refresh may make beyond the free ones. */
export type ReadMode =
  /** No provider calls: signals and linked pools only. */
  | "free"
  /** Probe accounts due one, and check held accounts. */
  | "probe"
  /** Check held accounts only: after a rate-limited request. */
  | "held";

type Read =
  | { readonly outcome: Exclude<Outcome, "cleared"> }
  | { readonly outcome: "cleared"; readonly cleared: ClearedCooldown };

/** Asks the provider and stores the answer; a failure keeps the windows read before. */
const probeAndSave = (
  endpoint: CliProxyApi.PoolEndpoint,
  account: CliProxyApi.ListedAccount,
  read: Parameters<typeof probe>[1],
  stored: Stored | undefined,
  now: number,
) =>
  probe(endpoint, read, now).pipe(
    Effect.tap((limits) => save(account.name, { limits, readAt: now, probedAt: now }, stored)),
    Effect.catchTags({
      // Says why only when there are no windows; with none, older signals may still fill in.
      LimitsProbeError: (error) => {
        const kept = stored !== undefined && stored.limits.windows.length > 0;
        const limits = kept
          ? stored.limits
          : makeUnavailableUsageLimits({
              checkedAt: isoAt(now),
              reason: "probeFailed",
              message: error.detail,
            });
        const readAt = kept ? stored.readAt : 0;
        return Effect.as(save(account.name, { limits, readAt, probedAt: now }, stored), null);
      },
    }),
  );

/**
 * One account's read; `stored` is what the cache held for it. An account
 * the CLIProxyAPI holds after a rate limit is checked with its provider
 * every `HELD_CHECK_MS`, and let go once every window has room again: the
 * CLIProxyAPI otherwise waits out the reset time the rate limit announced,
 * even when the provider reset the window early (#447).
 */
const readAccount = (
  endpoint: CliProxyApi.PoolEndpoint,
  account: CliProxyApi.ListedAccount,
  stored: Stored | undefined,
  now: number,
  mode: ReadMode,
): Effect.Effect<Read, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const usage = account.usage;
    if (usage._tag === "reported") {
      // A pool shares each account's windows with its admins only, and older ones not at all.
      const limits =
        usage.limits ??
        makeUnavailableUsageLimits({
          checkedAt: isoAt(now),
          reason: "unsupported",
          message: "The pool this one links to hasn't shared this account's limits.",
        });
      yield* save(
        account.name,
        { limits, readAt: Date.parse(limits.checkedAt), probedAt: 0 },
        stored,
      );
      return { outcome: "reported" };
    }
    if (!READS_LIMITS.has(account.type) || account.disabled || account.signedOut) {
      return { outcome: "skipped" };
    }
    const { observedAt, authIndex, heldUntil } = usage;
    const read =
      authIndex === null
        ? null
        : { type: account.type, authIndex, chatgptAccountId: usage.chatgptAccountId };
    const probedAt = stored?.probedAt ?? 0;
    if (
      mode !== "free" &&
      read !== null &&
      heldUntil !== null &&
      heldUntil - now > HELD_WORTH_CHECKING_MS
    ) {
      // A check from before the rate limit says nothing about it.
      const checkedSince = probedAt >= (observedAt ?? 0);
      if (!checkedSince || now - probedAt >= HELD_CHECK_MS) {
        const limits = yield* probeAndSave(endpoint, account, read, stored, now);
        if (limits === null) return { outcome: "probeFailed" };
        if (limits.windows.length === 0 || limits.windows.some((w) => w.usedPercent >= 100)) {
          return { outcome: "probed" };
        }
        const reset = yield* CliProxyApi.resetCooldown(endpoint, read.authIndex).pipe(
          Effect.as(true),
          Effect.catchTags({
            PoolBackendError: (error) =>
              Effect.as(Effect.logWarning("pool cooldown reset failed", error.detail), false),
          }),
        );
        if (!reset) return { outcome: "probed" };
        const used = limits.windows
          .map((window) => `${window.label} ${Math.round(window.usedPercent)}%`)
          .join(" and ");
        return {
          outcome: "cleared",
          cleared: {
            name: account.name,
            type: account.type,
            reason: `${providerName(account.type)} reports ${used} used, but it was held until ${isoAt(heldUntil)}.`,
            heldForMs: heldUntil - now,
          },
        };
      }
    }
    if (mode === "held") return { outcome: "skipped" };
    const signalled =
      observedAt === null ? null : fromSignals(account.type, usage.signals, observedAt);
    if (signalled !== null && observedAt !== null && observedAt > (stored?.readAt ?? 0)) {
      yield* save(account.name, { limits: signalled, readAt: observedAt, probedAt }, stored);
      return { outcome: "signals" };
    }
    // Spaced from the last read of either kind: fresh signals need no probe.
    const lastRead = Math.max(stored?.readAt ?? 0, probedAt);
    if (mode !== "probe" || read === null || now - lastRead < PROBE_INTERVAL_MS) {
      return { outcome: "skipped" };
    }
    const limits = yield* probeAndSave(endpoint, account, read, stored, now);
    return { outcome: limits === null ? "probeFailed" : "probed" };
  });

/**
 * Reads the windows of `live`'s accounts into the cache: a linked pool's
 * as its pool reported them, a CLIProxyAPI's from newer signals, or, with
 * `probe`, by asking the provider once `PROBE_INTERVAL_MS` has passed.
 * Lets go of accounts the CLIProxyAPI holds when their provider has room
 * again, and answers which. Callers run one refresh at a time, so an
 * account is never probed twice.
 */
export const refresh = (
  endpoint: CliProxyApi.PoolEndpoint,
  live: ReadonlyArray<CliProxyApi.ListedAccount>,
  now: number,
  mode: ReadMode,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const before = yield* storedRows;
    const names = new Set(live.map((account) => account.name));
    for (const name of before.keys()) {
      if (!names.has(name)) yield* sql`DELETE FROM account_limits WHERE name = ${name}`;
    }
    const reads = yield* Effect.forEach(
      live,
      (account) => readAccount(endpoint, account, before.get(account.name), now, mode),
      { concurrency: PROBE_CONCURRENCY },
    );
    const limits = yield* cached;
    yield* PoolUsageHistory.record(
      PoolUsageHistory.accountsWithQuota(
        live.map((account) => ({ ...account, usageLimits: limits.get(account.name) ?? null })),
      ),
      now,
    );
    const count = (outcome: Outcome) => reads.filter((each) => each.outcome === outcome).length;
    yield* Effect.annotateCurrentSpan({
      "pool.accounts": live.length,
      "pool.limits.signals": count("signals"),
      "pool.limits.probed": count("probed"),
      "pool.limits.probe_failed": count("probeFailed"),
      "pool.cooldowns.cleared": count("cleared"),
    });
    return reads.flatMap((each) => (each.outcome === "cleared" ? [each.cleared] : []));
  }).pipe(Effect.withSpan("PoolLimits.refresh"));

/** Forgets every account's windows, as when the pool switches to another CLIProxyAPI. */
export const clear = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM account_limits`;
  yield* PoolUsageHistory.clear;
});
