/**
 * Claude accounts in a CLIProxyAPI hub: banked resets (`cedar_ember`), the
 * plan tier, and redeeming a reset through the hub's `api-call` proxy.
 *
 * Claude only reports banked resets to its own CLI surface, recognized by the
 * user agent, so hub calls present themselves as the CLI. Unlike the native
 * instance this works on macOS too: the hub holds the token, not the keychain.
 *
 * Claude has 5-hour resets and full resets; each grant says which windows it
 * clears. Every window counts the credits that clear it, and a claim always
 * takes the narrowest grant that does the job, so a 5-hour limit never spends
 * a full reset.
 *
 * @module usage/hubClaude
 */
import {
  type ProviderConsumeResetCreditOutcome,
  type ServerProviderResetCredits,
  UsageLimitSourceError,
} from "@t3tools/contracts";
import { claudeResetCreditsForWindows } from "@t3tools/provider-core/server/resetCredits";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { formatClaudeSubscriptionAuthLabel } from "../provider/ClaudeProvider.ts";
import {
  CLAIM_OUTCOMES,
  ClaimResponse,
  RESET_CREDIT_FAILURES,
} from "../provider/claudeResetCredits.ts";

const API_BASE = "https://api.anthropic.com";

export const HUB_CLAUDE_USAGE_URL = `${API_BASE}/api/oauth/usage?cedar_ember=1&skip_spend=1`;
const PROFILE_URL = `${API_BASE}/api/oauth/profile`;

/** Claude checks the `claude-cli/` prefix, not the version. */
export const HUB_CLAUDE_HEADERS = {
  Authorization: "Bearer $TOKEN$",
  "anthropic-beta": "oauth-2025-04-20",
  "Content-Type": "application/json",
  "User-Agent": "claude-cli/2.1.291 (external, cli)",
};

const UsageExtras = Schema.Struct({
  cedar_ember: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        event_props: Schema.optional(
          Schema.NullOr(Schema.Struct({ tier: Schema.optional(Schema.NullOr(Schema.String)) })),
        ),
      }),
    ),
  ),
});
const decodeUsageExtras = Schema.decodeUnknownOption(UsageExtras);

/** The plan and banked resets in a parsed usage response. Missing pieces stay missing. */
export function hubClaudeUsageExtras(
  raw: unknown,
  windows: ReadonlyArray<{ readonly id: string; readonly usedPercent: number }>,
  nowMs: number,
): { readonly plan?: string; readonly resetCredits?: ServerProviderResetCredits } {
  const block = raw && typeof raw === "object" && "cedar_ember" in raw ? raw.cedar_ember : null;
  const tier = Option.getOrUndefined(decodeUsageExtras(raw))?.cedar_ember?.event_props?.tier;
  const plan = tier ? { plan: formatClaudeSubscriptionAuthLabel(tier) } : {};
  const resetCredits = claudeResetCreditsForWindows(block, windows, nowMs);
  return { ...plan, ...(resetCredits ? { resetCredits } : {}) };
}

const Profile = Schema.Struct({ organization: Schema.Struct({ uuid: Schema.String }) });
const decodeProfile = Schema.decodeUnknownEffect(Schema.fromJsonString(Profile));
const decodeClaim = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaimResponse));
const failure = (reason: keyof typeof RESET_CREDIT_FAILURES) =>
  new UsageLimitSourceError({ detail: RESET_CREDIT_FAILURES[reason] });

/**
 * Claims `grantId` for the account's organization through `call`, the hub's
 * proxy carrying the account's token. `requestId` makes a retry the same claim.
 */
export const consumeHubClaude = <E, R>(
  call: (url: string, data?: unknown) => Effect.Effect<string, E, R>,
  grantId: string,
  requestId: string,
): Effect.Effect<ProviderConsumeResetCreditOutcome, E | UsageLimitSourceError, R> =>
  Effect.gen(function* () {
    const profile = yield* call(PROFILE_URL).pipe(
      Effect.flatMap((body) =>
        decodeProfile(body).pipe(Effect.mapError(() => failure("accountUnreadable"))),
      ),
    );
    const organization = encodeURIComponent(profile.organization.uuid);
    const claim = yield* call(`${API_BASE}/api/organizations/${organization}/reset_rate_limits`, {
      program: "cedar_ember",
      grant_id: grantId,
      request_id: requestId,
    }).pipe(
      Effect.flatMap((body) =>
        decodeClaim(body).pipe(Effect.mapError(() => failure("requestFailed"))),
      ),
    );
    if (claim.result === "cooldown") return yield* failure("coolingDown");
    // Claude could not say whether the claim landed; a retry with the same id asks again.
    if (claim.result === "unavailable") return yield* failure("unconfirmed");
    return CLAIM_OUTCOMES[claim.result];
  });
