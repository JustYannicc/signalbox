import type {
  ProviderConsumeResetCreditOutcome,
  ServerProviderResetCredits,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const GRANT_ID = /^[a-z0-9_-]{1,40}$/;
const COMPLETE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const Grant = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(GRANT_ID)),
  resets_left: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ends_at: Schema.optional(Schema.NullOr(Schema.String)),
  paused: Schema.optional(Schema.Boolean),
  usable_now: Schema.optional(Schema.Boolean),
  // signalbox: the windows a claim clears; Claude has 5-hour and full resets.
  clears: Schema.optional(Schema.Array(Schema.String)),
});
export type ClaudeResetGrant = typeof Grant.Type;
const decodeGrant = Schema.decodeUnknownOption(Grant);
const CedarEmber = Schema.Struct({
  eligible: Schema.Boolean,
  grants: Schema.optional(Schema.Array(Schema.Unknown)),
  next_grant_id: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeCedarEmber = Schema.decodeUnknownOption(CedarEmber);
export const ClaimResponse = Schema.Struct({
  result: Schema.Literals([
    "reset",
    "already_used",
    "not_limited",
    "cooldown",
    "ineligible",
    "unavailable",
  ]),
});

export const RESET_CREDIT_FAILURES = {
  malformedCredit: "Claude returned a malformed reset credit.",
  loginUnreadable: "Claude could not read its login.",
  accountUnreadable: "Claude could not read its account.",
  signedOut: "Sign in to Claude again to redeem resets.",
  rateLimited: "Claude is rate limiting resets. Try again soon.",
  coolingDown: "Claude resets are cooling down. Try again later.",
  unconfirmed:
    "Claude could not confirm the reset. If you are still limited in a moment, try again.",
  requestFailed: "Claude could not redeem the reset.",
} as const;

const isFutureTimestamp = (value: string, nowMs: number) => {
  if (!COMPLETE_TIMESTAMP.test(value)) return false;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return (
    Date.parse(value) > nowMs && Date.UTC(year!, month! - 1, day!) <= Date.UTC(year!, month!, 0)
  );
};

function liveClaudeResetGrants(
  block: unknown,
  nowMs: number,
):
  | { readonly grants: ReadonlyArray<ClaudeResetGrant>; readonly nextGrantId: string | null }
  | undefined {
  const parsed = decodeCedarEmber(block);
  if (Option.isNone(parsed) || !parsed.value.eligible) return undefined;
  const grants = (parsed.value.grants ?? [])
    .flatMap((raw) => Option.toArray(decodeGrant(raw)))
    .filter(
      (grant) =>
        !grant.paused &&
        grant.usable_now &&
        (grant.ends_at == null || isFutureTimestamp(grant.ends_at, nowMs)),
    );
  return { grants, nextGrantId: parsed.value.next_grant_id ?? null };
}

export function claudeResetCreditsToContract(
  block: unknown,
  nowMs: number,
): ServerProviderResetCredits | undefined {
  const parsed = liveClaudeResetGrants(block, nowMs);
  if (!parsed) return undefined;
  const live = parsed.grants;
  const next = live.find((grant) => grant.id === parsed.nextGrantId);
  const nextExpiresAt = next?.ends_at ? DateTime.make(next.ends_at) : Option.none();
  return {
    availableCount: next ? live.reduce((sum, grant) => sum + grant.resets_left, 0) : 0,
    ...(Option.isSome(nextExpiresAt)
      ? { nextExpiresAt: DateTime.formatIso(nextExpiresAt.value) }
      : {}),
    ...(next ? { nextCreditId: next.id } : {}),
  };
}

export const CLAIM_OUTCOMES = {
  reset: "reset",
  not_limited: "nothingToReset",
  already_used: "alreadyRedeemed",
  ineligible: "noCredit",
} as const satisfies Record<string, ProviderConsumeResetCreditOutcome>;

type ClearingGrant = ClaudeResetGrant & { readonly clears: ReadonlyArray<string> };
type UsageWindow = { readonly id: string; readonly usedPercent: number };

const endsAt = (grant: ClaudeResetGrant) =>
  grant.ends_at ? Date.parse(grant.ends_at) : Number.POSITIVE_INFINITY;

// Fewest windows cleared first, then the soonest to expire.
const narrowestFirst = (a: ClearingGrant, b: ClearingGrant) =>
  a.clears.length - b.clears.length || endsAt(a) - endsAt(b);

function summarize(grants: ReadonlyArray<ClearingGrant>, pick: ClearingGrant | undefined) {
  const soonest = grants.toSorted((a, b) => endsAt(a) - endsAt(b))[0];
  const expires = soonest?.ends_at ? DateTime.make(soonest.ends_at) : Option.none();
  return {
    availableCount: grants.reduce((sum, grant) => sum + grant.resets_left, 0),
    ...(pick ? { nextCreditId: pick.id } : {}),
    ...(Option.isSome(expires) ? { nextExpiresAt: DateTime.formatIso(expires.value) } : {}),
  };
}

function splitResetCredits(
  grants: ReadonlyArray<ClearingGrant>,
  windows: ReadonlyArray<UsageWindow>,
): ServerProviderResetCredits {
  const byNarrowest = grants.toSorted(narrowestFirst);
  // The account-wide credit is what a plain "Use reset" claims: the narrowest
  // grant that clears every window at its limit right now.
  const limited = windows.filter((window) => window.usedPercent >= 100).map((window) => window.id);
  const pick =
    byNarrowest.find((grant) => limited.every((id) => grant.clears.includes(id))) ?? byNarrowest[0];
  const windowIds = [...new Set(grants.flatMap((grant) => grant.clears))];
  return {
    ...summarize(grants, pick),
    windows: windowIds.map((windowId) => {
      const clearing = byNarrowest.filter((grant) => grant.clears.includes(windowId));
      return { windowId, ...summarize(clearing, clearing[0]) };
    }),
  };
}

const clearsSomething = (grant: ClaudeResetGrant): grant is ClearingGrant =>
  grant.clears !== undefined;

/** Uses the same narrowest grant for cloud and self-hosted account actions. */
export function claudeResetCreditsForWindows(
  block: unknown,
  windows: ReadonlyArray<UsageWindow>,
  nowMs: number,
): ServerProviderResetCredits | undefined {
  const live = liveClaudeResetGrants(block, nowMs);
  if (!live) return undefined;
  const usable = live.grants.filter((grant) => grant.resets_left > 0);
  const clearing = usable.filter(clearsSomething);
  if (clearing.length !== usable.length) return claudeResetCreditsToContract(block, nowMs);
  return splitResetCredits(clearing, windows);
}
